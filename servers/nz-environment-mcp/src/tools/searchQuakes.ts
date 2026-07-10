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
} from "@nz-mcp/mcp-kit";
import { getRecentQuakes, type Quake } from "../clients/geonet.js";

export const searchQuakesInputShape = {
  min_mmi: z
    .number()
    .int()
    .min(-1)
    .max(8)
    .default(3)
    .describe(
      "Minimum Modified Mercalli Intensity (shaking severity) threshold, -1 to 8. GeoNet returns quakes that " +
        "may have caused shaking at or above this level anywhere in NZ. Default 3 (weak, widely felt).",
    ),
  min_magnitude: z.number().min(-2).max(10).optional().describe("Client-side filter: only quakes at or above this magnitude."),
  quality: z
    .enum(["best", "preliminary", "automatic", "deleted"])
    .optional()
    .describe("Client-side filter by GeoNet's data quality flag. Omit to include all qualities except 'deleted'."),
  limit: z.number().int().min(1).max(50).default(20).describe("Max results to return (1-50, default 20)."),
  offset: z.number().int().min(0).default(0).describe("Number of results to skip, for paging through a larger result set."),
  response_format: responseFormatParam,
};

export const searchQuakesOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchQuakesInputShape);

function toConcise(quake: Quake) {
  return {
    public_id: quake.publicID,
    time: quake.time,
    magnitude: Math.round(quake.magnitude * 10) / 10,
    depth_km: Math.round(quake.depth * 10) / 10,
    mmi: quake.mmi,
    locality: quake.locality,
    quality: quake.quality,
  };
}

function toDetailed(quake: Quake) {
  return {
    ...toConcise(quake),
    magnitude_precise: quake.magnitude,
    depth_km_precise: quake.depth,
    longitude: quake.longitude,
    latitude: quake.latitude,
  };
}

export async function searchQuakesHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const cacheKey = `geonet:quakes:mmi=${input.min_mmi}`;
    const allQuakes = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.NEAR_REALTIME, () => getRecentQuakes(input.min_mmi));

    const filtered = allQuakes.filter((quake) => {
      if (input.min_magnitude !== undefined && quake.magnitude < input.min_magnitude) return false;
      if (input.quality) return quake.quality === input.quality;
      return quake.quality !== "deleted";
    });

    const page = paginate(filtered, { limit: input.limit, offset: input.offset }, { defaultLimit: 20, maxLimit: 50 });
    const items = page.items.map((quake) => selectFormat(input.response_format, toConcise(quake), toDetailed(quake)));

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow with `min_mmi`, `min_magnitude`, or `quality`, or page with `offset`. " +
          "For dates beyond GeoNet's rolling 365-day/100-quake feed, use nz_env_search_quake_history instead.",
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
