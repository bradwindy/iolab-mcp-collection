import { z } from "zod";
import {
  attribution,
  CACHE_TTL,
  cached,
  jsonResult,
  missingCredentialError,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { getUvData } from "../clients/niwaUv.js";
import { getNiwaApiKey } from "../clients/niwaCredentials.js";
import { NIWA_API_KEY_NAME, SERVER_SLUG } from "../constants.js";

export const getUvForecastInputShape = {
  lat: z.number().min(-90).max(90).describe("Latitude in decimal degrees (negative for the Southern Hemisphere)."),
  long: z.number().min(-180).max(180).describe("Longitude in decimal degrees."),
};

export const getUvForecastOutputShape = {
  location: z.object({ lat: z.number(), long: z.number() }),
  forecast: z.array(z.record(z.string(), z.unknown())),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getUvForecastInputShape);

const KNOWN_SERIES_KEYS = ["values", "data", "forecast", "series"];

/**
 * Confirmed live 2026-07-10: NIWA's UV `/data` response is
 * `{ products: [{ name: "cloudy_sky_uv_index" | "clear_sky_uv_index", values: [{time, value}] }], coord }`
 * — two named series (cloudy-sky and clear-sky forecasts), not a single flat series. Each
 * product is surfaced as one `forecast[]` entry carrying its `product` name alongside its
 * `values`. The KNOWN_SERIES_KEYS fallback below is kept for defensiveness only, in case NIWA
 * changes shape again; a genuinely unrecognised shape still falls through to `raw_response` so
 * no information is lost.
 */
function extractForecastSeries(raw: unknown): { series: Array<Record<string, unknown>>; matchedKnownShape: boolean } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const products = (raw as Record<string, unknown>).products;
    if (
      Array.isArray(products) &&
      products.every((p) => p && typeof p === "object" && Array.isArray((p as Record<string, unknown>).values))
    ) {
      return {
        series: (products as Array<Record<string, unknown>>).map((p) => ({ product: p.name ?? null, values: p.values })),
        matchedKnownShape: true,
      };
    }
    for (const key of KNOWN_SERIES_KEYS) {
      const candidate = (raw as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) {
        return { series: candidate as Array<Record<string, unknown>>, matchedKnownShape: true };
      }
    }
  }
  if (Array.isArray(raw)) {
    return { series: raw as Array<Record<string, unknown>>, matchedKnownShape: true };
  }
  return { series: [{ raw_response: raw }], matchedKnownShape: false };
}

export async function getUvForecastHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const apiKey = await getNiwaApiKey(env);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, NIWA_API_KEY_NAME, env.PORTAL_URL);

  try {
    const cacheKey = `niwa:uv:${input.lat}:${input.long}`;
    const raw = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.SLOW_MOVING, () =>
      getUvData({ apiKey, lat: input.lat, long: input.long }),
    );

    const { series, matchedKnownShape } = extractForecastSeries(raw);

    const notice = matchedKnownShape
      ? ""
      : "This server could not confirm NIWA's exact UV forecast JSON shape ahead of time (see README.md); " +
        "returning the raw upstream payload verbatim under 'raw_response' inside `forecast[0]`.";

    return jsonResult({
      location: { lat: input.lat, long: input.long },
      forecast: series,
      notice,
      attribution: attribution("NIWA UV API", { url: "https://developer.niwa.co.nz/docs/uv-api/1/overview" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
