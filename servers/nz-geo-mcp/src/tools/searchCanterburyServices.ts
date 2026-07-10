import { z } from "zod";
import {
  attribution,
  jsonResult,
  limitParam,
  offsetParam,
  paginate,
  responseFormatParam,
  selectFormat,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { listAllServices, searchServices, type CanterburyServiceEntry } from "../clients/canterburyMaps.js";

export const searchCanterburyServicesInputShape = {
  query: z
    .string()
    .min(1)
    .max(120)
    .describe("Free-text (substring) match against Canterbury Maps ArcGIS service paths, e.g. 'groundwater' or 'flood'."),
  limit: limitParam(50, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchCanterburyServicesOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchCanterburyServicesInputShape);
const BASE_URL = "https://gis.ecan.govt.nz/arcgis/rest/services";

function toConcise(entry: CanterburyServiceEntry) {
  return { service_path: entry.path, type: entry.type };
}

function toDetailed(entry: CanterburyServiceEntry) {
  return {
    ...toConcise(entry),
    folder: entry.folder,
    rest_url: `${BASE_URL}/${entry.path}/${entry.type}`,
    queryable: entry.type === "FeatureServer" || entry.type === "MapServer",
    geocoder: entry.type === "GeocodeServer",
  };
}

export async function searchCanterburyServicesHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const all = await listAllServices(env.MCP_CACHE);
    const matched = searchServices(all, input.query);
    const { items: page, ...pageInfo } = paginate(matched, { limit: input.limit, offset: input.offset });

    const items = page.map((entry) => selectFormat(input.response_format, toConcise(entry), toDetailed(entry)));

    return jsonResult({
      items,
      ...pageInfo,
      notice: truncationNotice(input.offset + page.length, matched.length, "Narrow `query` or page with `offset`."),
      attribution: attribution("Canterbury Maps (Environment Canterbury)", {
        url: "https://gis.ecan.govt.nz/arcgis/rest/services",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
