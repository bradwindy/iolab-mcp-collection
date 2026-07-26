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
import { CAMERA_IMAGE_HOST, getCameras, SOURCE, type NztaCamera } from "../clients/nztaTraffic.js";
import { NZTA_REGIONS_DESCRIPTION, resolveNztaRegionId } from "../constants.js";

const MAX_LIMIT = 100;

export const getHighwayCamerasInputShape = {
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

export const getHighwayCamerasOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getHighwayCamerasInputShape);

function toFullUrl(path: string | undefined): string | null {
  if (!path) return null;
  return path.startsWith("http") ? path : `${CAMERA_IMAGE_HOST}${path}`;
}

function toConcise(camera: NztaCamera) {
  return {
    id: camera.id,
    name: camera.name ?? null,
    highway: camera.highway ?? null,
    direction: camera.direction ?? null,
    region: camera.region?.name ?? null,
    latitude: camera.latitude,
    longitude: camera.longitude,
    image_url: toFullUrl(camera.imageUrl),
    offline: camera.offline,
  };
}

function toDetailed(camera: NztaCamera) {
  return {
    ...toConcise(camera),
    description: camera.description ?? null,
    group: camera.group ?? null,
    thumbnail_url: toFullUrl(camera.thumbUrl),
    view_url: toFullUrl(camera.viewUrl),
    under_maintenance: camera.underMaintenance,
    state_highway: camera.way?.name ?? null,
  };
}

export async function getHighwayCamerasHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
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
    const cacheKey = `nzta:cameras:${regionId ?? "all"}`;
    const cameras = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.NEAR_REALTIME, () => getCameras(regionId));

    const page = paginate(cameras, { limit: input.limit, offset: input.offset }, { maxLimit: MAX_LIMIT });
    const items = page.items.map((camera) => selectFormat(input.response_format, toConcise(camera), toDetailed(camera)));

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
