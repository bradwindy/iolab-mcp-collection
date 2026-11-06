import { z } from "zod";
import {
  attribution,
  CACHE_TTL,
  cached,
  jsonResult,
  limitParam,
  missingCredentialError,
  offsetParam,
  paginate,
  responseFormatParam,
  selectFormat,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import {
  getServiceAlerts,
  SOURCE,
  toArray,
  type AlertFeedEntity,
  type GtfsRtActivePeriod,
  type GtfsRtTranslatedString,
} from "../clients/aucklandTransport.js";
import { getAtSubscriptionKey } from "../clients/credentialStore.js";
import { AT_SUBSCRIPTION_KEY_NAME, SERVER_SLUG } from "../constants.js";

const MAX_LIMIT = 100;

export const getRealtimeAlertsInputShape = {
  route: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe("Filter to alerts affecting this GTFS route_id (find ids with nz_transport_search_gtfs_routes)."),
  include_inactive: z
    .boolean()
    .default(false)
    .describe(
      "Include alerts that are not active right now (already ended, or not started yet). Default false: only alerts " +
        "with an active period where active_from <= now <= active_to are returned (a missing bound counts as open).",
    ),
  limit: limitParam(MAX_LIMIT, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const getRealtimeAlertsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getRealtimeAlertsInputShape);

function epochToIso(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  const seconds = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function affectedRoutes(entity: AlertFeedEntity): string[] {
  const ids = toArray(entity.alert?.informed_entity)
    .map((e) => e.route_id)
    .filter((v): v is string => Boolean(v));
  return Array.from(new Set(ids));
}

function firstTranslation(translated: GtfsRtTranslatedString | undefined): string | null {
  return toArray(translated?.translation)[0]?.text ?? null;
}

function epochSeconds(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  // GTFS-RT uses 0 (or an absent field) for an open bound.
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function isPeriodActive(period: GtfsRtActivePeriod, nowSeconds: number): boolean {
  const start = epochSeconds(period.start);
  const end = epochSeconds(period.end);
  return (start === null || start <= nowSeconds) && (end === null || nowSeconds <= end);
}

/**
 * True when one of the alert's active periods covers `nowSeconds` (missing start or end = open bound).
 * An alert with no active_period is active indefinitely (GTFS-RT spec).
 */
export function isActiveAlert(entity: AlertFeedEntity, nowSeconds: number): boolean {
  const periods = toArray(entity.alert?.active_period);
  return periods.length === 0 || periods.some((period) => isPeriodActive(period, nowSeconds));
}

function toConcise(entity: AlertFeedEntity, nowSeconds: number) {
  const alert = entity.alert;
  // Show the period that covers now, so an active alert does not display an older, ended window.
  const periods = toArray(alert?.active_period);
  const activePeriod = periods.find((period) => isPeriodActive(period, nowSeconds)) ?? periods[0];
  return {
    id: entity.id,
    cause: alert?.cause ?? null,
    effect: alert?.effect ?? null,
    header: firstTranslation(alert?.header_text),
    affected_routes: affectedRoutes(entity),
    active_from: epochToIso(activePeriod?.start),
    active_to: epochToIso(activePeriod?.end),
  };
}

function toDetailed(entity: AlertFeedEntity, nowSeconds: number) {
  return {
    ...toConcise(entity, nowSeconds),
    description: firstTranslation(entity.alert?.description_text),
    severity_level: entity.alert?.severity_level ?? null,
    url: firstTranslation(entity.alert?.url),
    informed_entities: toArray(entity.alert?.informed_entity),
  };
}

export async function getRealtimeAlertsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const subscriptionKey = await getAtSubscriptionKey(env);
  if (!subscriptionKey) return missingCredentialError(SERVER_SLUG, AT_SUBSCRIPTION_KEY_NAME, env.PORTAL_URL);

  try {
    const feed = await cached(env.MCP_CACHE, "at:service-alerts", CACHE_TTL.NEAR_REALTIME, () =>
      getServiceAlerts(subscriptionKey),
    );
    const allEntities = feed.entity ?? [];
    // The feed's own header timestamp (falling back to now), so "active" matches the snapshot served.
    const headerSeconds = Number(feed.header?.timestamp);
    const nowSeconds = Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : Date.now() / 1000;
    const current = input.include_inactive ? allEntities : allEntities.filter((e) => isActiveAlert(e, nowSeconds));
    const filtered = input.route
      ? current.filter((e) => toArray(e.alert?.informed_entity).some((ie) => ie.route_id === input.route))
      : current;

    const page = paginate(filtered, { limit: input.limit, offset: input.offset }, { maxLimit: MAX_LIMIT });
    const items = page.items.map((entity) => selectFormat(input.response_format, toConcise(entity, nowSeconds), toDetailed(entity, nowSeconds)));

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(input.offset + page.items.length, page.total_count, "Narrow with `route`."),
      attribution: attribution(SOURCE, { url: "https://dev-portal.at.govt.nz/realtime-api" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
