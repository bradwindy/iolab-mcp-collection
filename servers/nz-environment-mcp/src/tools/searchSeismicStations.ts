import { z } from "zod";
import {
  attribution,
  CACHE_TTL,
  cached,
  jsonResult,
  paginate,
  responseFormatParam,
  selectFormat,
  toolError,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { searchStations, type FdsnStationRecord } from "../clients/geonetFdsn.js";

export const searchSeismicStationsInputShape = {
  network: z.string().min(1).max(10).optional().describe("FDSN network code, e.g. 'NZ'. Omit to search all networks."),
  station: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe("Station code or wildcard pattern, e.g. 'WEL' or 'W*'. Omit to list all stations (optionally scoped by bbox)."),
  bbox: z
    .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
    .optional()
    .describe("Bounding box [west, south, east, north] in decimal degrees to restrict the search area."),
  limit: z.number().int().min(1).max(50).default(20).describe("Max results to return (1-50, default 20)."),
  offset: z.number().int().min(0).default(0).describe("Number of results to skip, for paging through a larger result set."),
  response_format: responseFormatParam,
};

export const searchSeismicStationsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchSeismicStationsInputShape);

function toConcise(record: FdsnStationRecord) {
  return {
    network: record.network,
    station: record.station,
    site_name: record.siteName,
    longitude: record.longitude,
    latitude: record.latitude,
  };
}

function toDetailed(record: FdsnStationRecord) {
  return {
    ...toConcise(record),
    elevation_m: record.elevationM,
    start_time: record.startTime,
    end_time: record.endTime || null,
  };
}

export async function searchSeismicStationsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  if (!input.network && !input.station && !input.bbox) {
    return toolError(
      "Provide at least a `network`, `station`, or `bbox`.",
      "Searching with none of these would return GeoNet's entire station network.",
    );
  }

  try {
    const queryParams = {
      ...(input.network ? { network: input.network } : {}),
      ...(input.station ? { station: input.station } : {}),
      ...(input.bbox ? { bbox: input.bbox } : {}),
    };
    const cacheKey = `fdsn:stations:${JSON.stringify(queryParams)}`;
    const allRecords = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.METADATA, () => searchStations(queryParams));

    const page = paginate(allRecords, { limit: input.limit, offset: input.offset }, { defaultLimit: 20, maxLimit: 50 });
    const items = page.items.map((record) => selectFormat(input.response_format, toConcise(record), toDetailed(record)));

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(input.offset + page.items.length, page.total_count, "Narrow with `network`, `station`, or `bbox`, or page with `offset`."),
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
