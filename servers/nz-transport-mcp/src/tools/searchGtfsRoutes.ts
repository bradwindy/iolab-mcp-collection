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
import { getAllRoutes, SOURCE, type GtfsRouteAttributes } from "../clients/aucklandTransport.js";
import { getAtSubscriptionKey } from "../clients/credentialStore.js";
import { AT_SUBSCRIPTION_KEY_NAME, SERVER_SLUG } from "../constants.js";

const MAX_LIMIT = 100;

export const searchGtfsRoutesInputShape = {
  query: z
    .string()
    .min(1)
    .max(120)
    .describe("Free-text, case-insensitive match against the route's short name or long name (e.g. 'Outer Link', '70')."),
  limit: limitParam(MAX_LIMIT, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchGtfsRoutesOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchGtfsRoutesInputShape);

function toConcise(attrs: GtfsRouteAttributes) {
  return {
    route_id: attrs.route_id ?? null,
    short_name: attrs.route_short_name ?? null,
    long_name: attrs.route_long_name ?? null,
    route_type: attrs.route_type ?? null,
  };
}

function toDetailed(attrs: GtfsRouteAttributes) {
  return {
    ...toConcise(attrs),
    agency_id: attrs.agency_id ?? null,
    description: attrs.route_desc ?? null,
    color: attrs.route_color ?? null,
    text_color: attrs.route_text_color ?? null,
    url: attrs.route_url ?? null,
  };
}

export async function searchGtfsRoutesHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const subscriptionKey = await getAtSubscriptionKey(env);
  if (!subscriptionKey) return missingCredentialError(SERVER_SLUG, AT_SUBSCRIPTION_KEY_NAME, env.PORTAL_URL);

  try {
    // The route list changes only with periodic network changes; cache the full fetch for 24h.
    const routes = await cached(env.MCP_CACHE, "at:gtfs:routes", CACHE_TTL.METADATA, () => getAllRoutes(subscriptionKey));

    const needle = input.query.toLowerCase();
    const matches = routes.data.filter((r) => {
      const short = r.attributes.route_short_name?.toLowerCase() ?? "";
      const long = r.attributes.route_long_name?.toLowerCase() ?? "";
      return short.includes(needle) || long.includes(needle);
    });

    const page = paginate(matches, { limit: input.limit, offset: input.offset }, { maxLimit: MAX_LIMIT });
    const items = page.items.map((r) => selectFormat(input.response_format, toConcise(r.attributes), toDetailed(r.attributes)));

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
