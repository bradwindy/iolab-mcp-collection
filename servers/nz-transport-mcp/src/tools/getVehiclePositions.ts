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
} from "@nz-mcp/mcp-kit";
import { getVehiclePositions as fetchVehiclePositions, SOURCE, type VehicleFeedEntity } from "../clients/aucklandTransport.js";
import { getAtSubscriptionKey } from "../clients/credentialStore.js";
import { AT_SUBSCRIPTION_KEY_NAME, PORTAL_URL, SERVER_SLUG } from "../constants.js";

const MAX_LIMIT = 200;

export const getVehiclePositionsInputShape = {
  route: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe("Filter to vehicles currently serving this GTFS route_id (find ids with nz_transport_search_gtfs_routes)."),
  limit: limitParam(MAX_LIMIT, 50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const getVehiclePositionsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getVehiclePositionsInputShape);

function epochToIso(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  const seconds = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function toConcise(entity: VehicleFeedEntity) {
  const v = entity.vehicle;
  return {
    vehicle_id: v?.vehicle?.id ?? entity.id,
    route_id: v?.trip?.route_id ?? null,
    trip_id: v?.trip?.trip_id ?? null,
    latitude: v?.position?.latitude ?? null,
    longitude: v?.position?.longitude ?? null,
    bearing: v?.position?.bearing ?? null,
    speed_kmh: typeof v?.position?.speed === "number" ? Math.round(v.position.speed * 3.6 * 10) / 10 : null,
    last_updated: epochToIso(v?.timestamp),
  };
}

function toDetailed(entity: VehicleFeedEntity) {
  const v = entity.vehicle;
  return {
    ...toConcise(entity),
    vehicle_label: v?.vehicle?.label ?? null,
    license_plate: v?.vehicle?.license_plate ?? null,
    direction_id: v?.trip?.direction_id ?? null,
    start_time: v?.trip?.start_time ?? null,
    start_date: v?.trip?.start_date ?? null,
    current_stop_sequence: v?.current_stop_sequence ?? null,
    stop_id: v?.stop_id ?? null,
    current_status: v?.current_status ?? null,
    congestion_level: v?.congestion_level ?? null,
    occupancy_status: v?.occupancy_status ?? null,
  };
}

export async function getVehiclePositionsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const subscriptionKey = await getAtSubscriptionKey(env);
  if (!subscriptionKey) return missingCredentialError(SERVER_SLUG, AT_SUBSCRIPTION_KEY_NAME, PORTAL_URL);

  try {
    const feed = await cached(env.MCP_CACHE, "at:vehicle-positions", CACHE_TTL.NEAR_REALTIME, () =>
      fetchVehiclePositions(subscriptionKey),
    );
    const allEntities = feed.entity ?? [];
    const filtered = input.route ? allEntities.filter((e) => e.vehicle?.trip?.route_id === input.route) : allEntities;

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
