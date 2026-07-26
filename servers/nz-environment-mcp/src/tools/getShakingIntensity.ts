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
import { getShakingIntensity as getShakingIntensityClient, type IntensityPoint } from "../clients/geonet.js";

const PUBLIC_ID_PATTERN = /^\d{4}p\d+$/i;

export const getShakingIntensityInputShape = {
  type: z
    .enum(["measured", "reported"])
    .describe("'measured' = instrument shaking readings; 'reported' = public felt-intensity reports."),
  aggregation: z
    .enum(["max", "median"])
    .optional()
    .describe("Aggregation for `type=reported` where multiple reports exist per area. Default max."),
  public_id: z
    .string()
    .regex(PUBLIC_ID_PATTERN, "Expected a GeoNet public ID like '2013p407387'.")
    .optional()
    .describe(
      "A quake's GeoNet public ID to scope reports to the time window around that quake. Only valid with " +
        "type='reported'. Omit for a snapshot of the last 60 minutes network-wide.",
    ),
  limit: z.number().int().min(1).max(50).default(20).describe("Max points to return (1-50, default 20)."),
  offset: z.number().int().min(0).default(0).describe("Number of points to skip, for paging through a larger result set."),
  response_format: responseFormatParam,
};

export const getShakingIntensityOutputShape = {
  summary: z.object({ count: z.number(), count_by_mmi: z.record(z.string(), z.number()) }),
  points: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getShakingIntensityInputShape);

function toConcise(point: IntensityPoint) {
  return {
    mmi: point.mmi,
    longitude: Math.round(point.longitude * 100) / 100,
    latitude: Math.round(point.latitude * 100) / 100,
  };
}

function toDetailed(point: IntensityPoint) {
  return {
    ...toConcise(point),
    count: point.count,
    count_by_mmi: point.count_mmi,
  };
}

export async function getShakingIntensityHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  if (input.public_id && input.type !== "reported") {
    return toolError("`public_id` is only valid with type='reported'.", "Omit it, or set type='reported'.");
  }

  try {
    const cacheKey = `geonet:intensity:${input.type}:${input.aggregation ?? "max"}:${input.public_id ?? ""}`;
    const result = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.NEAR_REALTIME, () =>
      getShakingIntensityClient({
        type: input.type,
        ...(input.aggregation ? { aggregation: input.aggregation } : {}),
        ...(input.public_id ? { publicId: input.public_id } : {}),
      }),
    );

    const page = paginate(result.points, { limit: input.limit, offset: input.offset }, { defaultLimit: 20, maxLimit: 50 });
    const points = page.items.map((point) => selectFormat(input.response_format, toConcise(point), toDetailed(point)));

    return jsonResult({
      summary: { count: result.count, count_by_mmi: result.count_mmi },
      points,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "The `summary` field already covers every point; page through `points` with `offset` for individual locations.",
      ),
      attribution: attribution("GeoNet (GNS Science)", {
        license: "CC BY 3.0 NZ",
        url: "https://www.geonet.org.nz/data/policy",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
