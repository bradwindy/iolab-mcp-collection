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
  include_expired: z
    .boolean()
    .default(false)
    .describe("Include alerts whose every active period has already ended. Default false: AT's feed keeps some expired alerts."),
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

/**
 * True when the alert has at least one active period and all of them ended before `nowSeconds`.
 * An alert with no active_period is active indefinitely (GTFS-RT spec), so it is never expired.
 */
export function isExpiredAlert(entity: AlertFeedEntity, nowSeconds: number): boolean {
  const periods = toArray(entity.alert?.active_period);
  if (periods.length === 0) return false;
  return periods.every((period) => {
    const end = Number(period.end);
    return period.end !== undefined && Number.isFinite(end) && end > 0 && end < nowSeconds;
  });
}

function toConcise(entity: AlertFeedEntity) {
  const alert = entity.alert;
  const activePeriod = toArray(alert?.active_period)[0];
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

function toDetailed(entity: AlertFeedEntity) {
  return {
    ...toConcise(entity),
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
    // The feed's own header timestamp (falling back to now), so expiry matches the snapshot served.
    const headerSeconds = Number(feed.header?.timestamp);
    const nowSeconds = Number.isFinite(headerSeconds) && headerSeconds > 0 ? headerSeconds : Date.now() / 1000;
    const current = input.include_expired ? allEntities : allEntities.filter((e) => !isExpiredAlert(e, nowSeconds));
    const filtered = input.route
      ? current.filter((e) => toArray(e.alert?.informed_entity).some((ie) => ie.route_id === input.route))
      : current;

    const page = paginate(filtered, { limit: input.limit, offset: input.offset }, { maxLimit: MAX_LIMIT });
    const items = page.items.map((entity) => selectFormat(input.response_format, toConcise(entity), toDetailed(entity)));

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
