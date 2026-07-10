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
import { getTideData } from "../clients/niwaTides.js";
import { getNiwaApiKey } from "../clients/niwaCredentials.js";
import { NIWA_API_KEY_NAME, PORTAL_URL, SERVER_SLUG } from "../constants.js";

export const getTideForecastInputShape = {
  lat: z.number().min(-90).max(90).describe("Latitude in decimal degrees (negative for the Southern Hemisphere)."),
  long: z.number().min(-180).max(180).describe("Longitude in decimal degrees."),
  days: z
    .number()
    .int()
    .min(1)
    .max(31)
    .default(2)
    .describe("Number of days of tide predictions to return from `start_date` (default 2)."),
  start_date: z.string().min(4).max(10).optional().describe("ISO date (YYYY-MM-DD) to start predictions from. Defaults to today."),
  datum: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe("Tidal datum reference, e.g. 'MSL' (mean sea level) or 'LAT' (lowest astronomical tide). Defaults to NIWA's standard datum."),
};

export const getTideForecastOutputShape = {
  location: z.object({ lat: z.number(), long: z.number() }),
  tides: z.array(z.object({ time: z.string(), height_m: z.number() })),
  count: z.number(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getTideForecastInputShape);

export async function getTideForecastHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const apiKey = await getNiwaApiKey(env);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, NIWA_API_KEY_NAME, PORTAL_URL);

  try {
    const cacheKey = `niwa:tides:${input.lat}:${input.long}:${input.days}:${input.start_date ?? ""}:${input.datum ?? ""}`;
    const data = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.SLOW_MOVING, () =>
      getTideData({
        apiKey,
        lat: input.lat,
        long: input.long,
        numberOfDays: input.days,
        ...(input.start_date ? { startDate: input.start_date } : {}),
        ...(input.datum ? { datum: input.datum } : {}),
      }),
    );

    const tides = data.values.map((value) => ({ time: value.time, height_m: value.value }));

    const notice =
      "`tides` lists alternating high/low tide extrema (not an hourly curve) unless NIWA returns a denser series. " +
      "Heights are relative to the requested (or NIWA default) datum.";

    return jsonResult({
      location: { lat: input.lat, long: input.long },
      tides,
      count: tides.length,
      notice,
      attribution: attribution("NIWA Tide Forecasting API", {
        url: "https://developer.niwa.co.nz/docs/tide-api/latest/overview",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
