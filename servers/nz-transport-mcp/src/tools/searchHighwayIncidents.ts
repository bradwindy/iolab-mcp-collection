import { z } from "zod";
import {
  attribution,
  CACHE_TTL,
  cached,
  jsonResult,
  limitParam,
  offsetParam,
  paginate,
  responseFormatParam,
  selectFormat,
  toolError,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { getRoadEvents, SOURCE, type NztaRoadEvent } from "../clients/nztaTraffic.js";
import { NZTA_REGIONS_DESCRIPTION, resolveNztaRegionId } from "../constants.js";

const MAX_LIMIT = 100;

export const searchHighwayIncidentsInputShape = {
  region: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      `Filter to one NZTA traffic region, by name or numeric id. Valid regions: ${NZTA_REGIONS_DESCRIPTION}.`,
    ),
  limit: limitParam(MAX_LIMIT, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchHighwayIncidentsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchHighwayIncidentsInputShape);

function toConcise(event: NztaRoadEvent) {
  return {
    id: event.id,
    category: event.eventType ?? null,
    description: event.eventDescription ?? null,
    status: event.status ?? null,
    impact: event.impact ?? null,
    region: event.region?.name ?? null,
    location: event.locationArea ?? null,
    planned: event.planned,
    starts: event.startDate ?? null,
    ends: event.endDate ?? null,
  };
}

function toDetailed(event: NztaRoadEvent) {
  return {
    ...toConcise(event),
    comments: event.eventComments ?? null,
    alternative_route: event.alternativeRoute ?? null,
    expected_resolution: event.expectedResolution ?? null,
    information_source: event.informationSource ?? null,
    supplier: event.supplier ?? null,
    state_highway: event.way?.name ?? null,
    locations: event.locations ?? [],
    created: event.eventCreated ?? null,
    modified: event.eventModified ?? null,
  };
}

export async function searchHighwayIncidentsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  let regionId: number | undefined;
  if (input.region) {
    const resolved = resolveNztaRegionId(input.region);
    if (resolved === null) {
      return toolError(
        `Unknown region '${input.region}'.`,
        `Valid regions: ${NZTA_REGIONS_DESCRIPTION}.`,
      );
    }
    regionId = resolved;
  }

  try {
    const cacheKey = `nzta:events:${regionId ?? "all"}`;
    const events = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.NEAR_REALTIME, () => getRoadEvents(regionId));

    const page = paginate(events, { limit: input.limit, offset: input.offset }, { maxLimit: MAX_LIMIT });
    const items = page.items.map((event) => selectFormat(input.response_format, toConcise(event), toDetailed(event)));

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(input.offset + page.items.length, page.total_count, "Narrow with `region`."),
      attribution: attribution(SOURCE, {
        url: "https://www.nzta.govt.nz/traffic-and-travel-information/use-our-data/about-the-apis",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
