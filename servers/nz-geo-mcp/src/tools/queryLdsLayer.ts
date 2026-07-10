import { z } from "zod";
import {
  attribution,
  jsonResult,
  limitParam,
  missingCredentialError,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { queryVector } from "../clients/linzDataService.js";
import { summarizeGeoJsonGeometry } from "../geo.js";
import { MissingCredentialError, requireLinzCredential } from "../credentials.js";
import { SERVER_SLUG } from "../constants.js";

export const queryLdsLayerInputShape = {
  layer_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(5)
    .describe(
      "One or more LINZ Data Service layer ids to query together, e.g. [50772] for NZ Primary Parcels. " +
        "Find layer ids from a dataset's page at data.linz.govt.nz/layer/{id}-{slug}.",
    ),
  lat: z.number().min(-90).max(90).describe("Query point latitude, WGS84 decimal degrees."),
  lon: z.number().min(-180).max(180).describe("Query point longitude, WGS84 decimal degrees."),
  radius_m: z
    .number()
    .min(0)
    .max(100000)
    .default(1000)
    .describe("Search radius in metres around (lat, lon). Upstream valid range 0-100000 (100km)."),
  max_results: limitParam(100, 10),
  include_geometry: z
    .boolean()
    .default(false)
    .describe(
      "If true, include each feature's centroid and bounding box (never raw polygon/line coordinates, " +
        "per this collection's geospatial guidance).",
    ),
};

export const queryLdsLayerOutputShape = {
  query: z.object({ lat: z.number(), lon: z.number(), radius_m: z.number(), max_results: z.number() }),
  layers: z.array(
    z.object({
      layer_id: z.number(),
      layer_name: z.string().nullable(),
      feature_count: z.number(),
      features: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
  notice: z.string(),
  attribution: z.object({ source: z.string(), license: z.string().optional(), url: z.string().optional() }),
};

const inputSchema = z.object(queryLdsLayerInputShape);

export async function queryLdsLayerHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const apiKey = await requireLinzCredential(env, "LINZ_API_KEY");

    const layers = await queryVector({
      apiKey,
      layerIds: input.layer_ids,
      lat: input.lat,
      lon: input.lon,
      radiusM: input.radius_m,
      maxResults: input.max_results,
      includeGeometry: input.include_geometry,
    });

    let anyTruncated = false;
    const formattedLayers = layers.map((layer) => {
      if (layer.features.length >= input.max_results) anyTruncated = true;
      return {
        layer_id: layer.layerId,
        layer_name: layer.name,
        feature_count: layer.features.length,
        features: layer.features.map((feature) => {
          const record: Record<string, unknown> = { ...feature.properties };
          if (input.include_geometry) {
            record.geometry_summary = summarizeGeoJsonGeometry(feature.geometry);
          }
          return record;
        }),
      };
    });

    return jsonResult({
      query: { lat: input.lat, lon: input.lon, radius_m: input.radius_m, max_results: input.max_results },
      layers: formattedLayers,
      notice: anyTruncated
        ? "One or more layers returned the maximum `max_results` requested — there may be more features " +
          "within `radius_m`. Increase `max_results` (max 100) or narrow `radius_m` to refine."
        : "",
      attribution: attribution("LINZ Data Service", {
        license: "CC BY 4.0",
        url: "https://data.linz.govt.nz/",
      }),
    });
  } catch (error) {
    if (error instanceof MissingCredentialError) {
      return missingCredentialError(SERVER_SLUG, error.keyName, env.PORTAL_URL);
    }
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
