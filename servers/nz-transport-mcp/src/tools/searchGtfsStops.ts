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
import { getAllStops, SOURCE, type GtfsStopAttributes } from "../clients/aucklandTransport.js";
import { getAtSubscriptionKey } from "../clients/credentialStore.js";
import { AT_SUBSCRIPTION_KEY_NAME, SERVER_SLUG } from "../constants.js";

const MAX_LIMIT = 100;

export const searchGtfsStopsInputShape = {
  query: z.string().min(1).max(120).describe("Free-text, case-insensitive match against the Auckland Transport stop name."),
  limit: limitParam(MAX_LIMIT, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchGtfsStopsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchGtfsStopsInputShape);

function toConcise(attrs: GtfsStopAttributes) {
  return {
    stop_id: attrs.stop_id,
    stop_code: attrs.stop_code ?? null,
    name: attrs.stop_name,
    latitude: attrs.stop_lat,
    longitude: attrs.stop_lon,
  };
}

function toDetailed(attrs: GtfsStopAttributes) {
  return {
    ...toConcise(attrs),
    location_type: attrs.location_type ?? null,
    wheelchair_boarding: attrs.wheelchair_boarding ?? null,
  };
}

export async function searchGtfsStopsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const subscriptionKey = await getAtSubscriptionKey(env);
  if (!subscriptionKey) return missingCredentialError(SERVER_SLUG, AT_SUBSCRIPTION_KEY_NAME, env.PORTAL_URL);

  try {
    // The stop list is effectively static day-to-day; cache the full fetch for 24h so repeated
    // searches don't re-pull every stop in the network on every call.
    const journeyDate = new Date().toISOString().slice(0, 10);
    const stops = await cached(env.MCP_CACHE, `at:gtfs:stops:${journeyDate}`, CACHE_TTL.METADATA, () =>
      getAllStops(subscriptionKey, journeyDate),
    );

    const needle = input.query.toLowerCase();
    const matches = stops.data.filter((s) => s.attributes.stop_name?.toLowerCase().includes(needle));

    const page = paginate(matches, { limit: input.limit, offset: input.offset }, { maxLimit: MAX_LIMIT });
    const items = page.items.map((s) => selectFormat(input.response_format, toConcise(s.attributes), toDetailed(s.attributes)));

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(input.offset + page.items.length, page.total_count, "Narrow `query` to refine results."),
      attribution: attribution(SOURCE, { url: "https://dev-portal.at.govt.nz/GTFS-API" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
