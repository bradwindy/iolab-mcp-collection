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
import { getTripUpdates as fetchTripUpdates, SOURCE, toArray, type TripUpdateFeedEntity } from "../clients/aucklandTransport.js";
import { getAtSubscriptionKey } from "../clients/credentialStore.js";
import { AT_SUBSCRIPTION_KEY_NAME, SERVER_SLUG } from "../constants.js";

const MAX_LIMIT = 200;
const MAX_STOP_UPDATES_DETAILED = 20;
/** A trip update this much older than the feed itself is no longer live. */
const STALE_AFTER_SECONDS = 30 * 60;

export const getTripUpdatesInputShape = {
  route: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe("Filter to trips on this GTFS route_id (find ids with nz_transport_search_gtfs_routes)."),
  include_stale: z
    .boolean()
    .default(false)
    .describe(
      "Include trip updates last refreshed more than 30 minutes before the feed's own timestamp. Default false: AT's feed keeps some trips long after they stopped reporting.",
    ),
  limit: limitParam(MAX_LIMIT, 50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const getTripUpdatesOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getTripUpdatesInputShape);

function epochToIso(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  const seconds = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function toSeconds(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Stale = has a timestamp more than STALE_AFTER_SECONDS behind `feedSeconds`. No timestamp is kept. */
export function isStaleTripUpdate(entity: TripUpdateFeedEntity, feedSeconds: number): boolean {
  const updated = toSeconds(entity.trip_update?.timestamp);
  return updated !== null && feedSeconds - updated > STALE_AFTER_SECONDS;
}

function toConcise(entity: TripUpdateFeedEntity) {
  const tu = entity.trip_update;
  const stopUpdates = toArray(tu?.stop_time_update);
  const next = stopUpdates[0];
  return {
    trip_id: tu?.trip?.trip_id ?? null,
    route_id: tu?.trip?.route_id ?? null,
    vehicle_id: tu?.vehicle?.id ?? null,
    delay_seconds: tu?.delay ?? next?.arrival?.delay ?? next?.departure?.delay ?? null,
    next_stop: next
      ? {
          stop_id: next.stop_id ?? null,
          arrival_delay_seconds: next.arrival?.delay ?? null,
          departure_delay_seconds: next.departure?.delay ?? null,
        }
      : null,
    stop_updates_count: stopUpdates.length,
    last_updated: epochToIso(tu?.timestamp),
  };
}

function toDetailed(entity: TripUpdateFeedEntity) {
  const tu = entity.trip_update;
  const stopUpdates = toArray(tu?.stop_time_update);
  return {
    ...toConcise(entity),
    direction_id: tu?.trip?.direction_id ?? null,
    start_time: tu?.trip?.start_time ?? null,
    start_date: tu?.trip?.start_date ?? null,
    schedule_relationship: tu?.trip?.schedule_relationship ?? null,
    stop_updates: stopUpdates.slice(0, MAX_STOP_UPDATES_DETAILED).map((s) => ({
      stop_sequence: s.stop_sequence ?? null,
      stop_id: s.stop_id ?? null,
      arrival_delay_seconds: s.arrival?.delay ?? null,
      arrival_time: epochToIso(s.arrival?.time),
      departure_delay_seconds: s.departure?.delay ?? null,
      departure_time: epochToIso(s.departure?.time),
    })),
    stop_updates_truncated: stopUpdates.length > MAX_STOP_UPDATES_DETAILED,
  };
}

export async function getTripUpdatesHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const subscriptionKey = await getAtSubscriptionKey(env);
  if (!subscriptionKey) return missingCredentialError(SERVER_SLUG, AT_SUBSCRIPTION_KEY_NAME, env.PORTAL_URL);

  try {
    const feed = await cached(env.MCP_CACHE, "at:trip-updates", CACHE_TTL.NEAR_REALTIME, () =>
      fetchTripUpdates(subscriptionKey),
    );
    const allEntities = feed.entity ?? [];
    // Measured against the feed's own header timestamp, else its newest trip update, so a feed
    // served from cache doesn't make every trip look stale.
    const newestUpdate = Math.max(0, ...allEntities.map((e) => toSeconds(e.trip_update?.timestamp) ?? 0));
    const feedSeconds = toSeconds(feed.header?.timestamp) ?? (newestUpdate || Date.now() / 1000);
    const current = input.include_stale ? allEntities : allEntities.filter((e) => !isStaleTripUpdate(e, feedSeconds));
    const filtered = input.route ? current.filter((e) => e.trip_update?.trip?.route_id === input.route) : current;

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
