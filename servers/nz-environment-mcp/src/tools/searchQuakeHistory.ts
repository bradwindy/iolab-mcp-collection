import { z } from "zod";
import {
  attribution,
  CACHE_TTL,
  cached,
  jsonResult,
  paginate,
  responseFormatParam,
  selectFormat,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { searchQuakeHistory as searchQuakeHistoryClient, type FdsnQuakeRecord } from "../clients/geonetFdsn.js";

const bboxParam = z
  .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .optional()
  .describe("Bounding box [west, south, east, north] in decimal degrees to restrict the search area.");

export const searchQuakeHistoryInputShape = {
  start_time: z.string().min(4).describe("ISO 8601 start of the search window, e.g. '2026-01-01' or '2026-01-01T00:00:00'."),
  end_time: z.string().min(4).describe("ISO 8601 end of the search window."),
  min_magnitude: z.number().min(-2).max(10).optional().describe("Only events at or above this magnitude."),
  max_magnitude: z.number().min(-2).max(10).optional().describe("Only events at or below this magnitude."),
  min_depth_km: z.number().min(0).max(1000).optional().describe("Only events at or deeper than this depth in km."),
  max_depth_km: z.number().min(0).max(1000).optional().describe("Only events at or shallower than this depth in km."),
  bbox: bboxParam,
  event_type: z
    .string()
    .max(60)
    .optional()
    .describe("QuakeML EventType filter, e.g. 'earthquake' or 'outside of network interest'. Omit for all types."),
  limit: z.number().int().min(1).max(50).default(20).describe("Max results to return (1-50, default 20)."),
  offset: z.number().int().min(0).default(0).describe("Number of results to skip, for paging through a larger result set."),
  response_format: responseFormatParam,
};

export const searchQuakeHistoryOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchQuakeHistoryInputShape);

function toConcise(record: FdsnQuakeRecord) {
  return {
    event_id: record.eventId,
    time: record.time,
    magnitude: record.magnitude,
    magnitude_type: record.magnitudeType,
    depth_km: record.depthKm,
    location_name: record.locationName,
    event_type: record.eventType,
  };
}

function toDetailed(record: FdsnQuakeRecord) {
  return {
    ...toConcise(record),
    longitude: record.longitude,
    latitude: record.latitude,
    author: record.author,
    magnitude_author: record.magnitudeAuthor,
    catalog: record.catalog,
    contributor: record.contributor,
    contributor_id: record.contributorId,
  };
}

export async function searchQuakeHistoryHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    // Cache key covers only the upstream query params — limit/offset/response_format are
    // applied client-side below, so they must not fragment the cache.
    const queryParams = {
      startTime: input.start_time,
      endTime: input.end_time,
      ...(input.min_magnitude !== undefined ? { minMagnitude: input.min_magnitude } : {}),
      ...(input.max_magnitude !== undefined ? { maxMagnitude: input.max_magnitude } : {}),
      ...(input.min_depth_km !== undefined ? { minDepth: input.min_depth_km } : {}),
      ...(input.max_depth_km !== undefined ? { maxDepth: input.max_depth_km } : {}),
      ...(input.bbox ? { bbox: input.bbox } : {}),
      ...(input.event_type ? { eventType: input.event_type } : {}),
      orderBy: "time" as const,
    };
    const cacheKey = `fdsn:events:${JSON.stringify(queryParams)}`;
    const allRecords = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.SLOW_MOVING, () =>
      searchQuakeHistoryClient(queryParams),
    );

    const page = paginate(allRecords, { limit: input.limit, offset: input.offset }, { defaultLimit: 20, maxLimit: 50 });
    const items = page.items.map((record) => selectFormat(input.response_format, toConcise(record), toDetailed(record)));

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow the time range or add magnitude/depth/bbox filters, or page with `offset`. " +
          "GeoNet caps a single query at 10,000 events; the near-real-time index covers the last ~8 days " +
          "and the archive lags live events by ~7 days.",
      ),
      attribution: attribution("GeoNet FDSN Web Services (GNS Science)", {
        license: "CC BY 3.0 NZ",
        url: "https://www.geonet.org.nz/data/access/FDSN",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
