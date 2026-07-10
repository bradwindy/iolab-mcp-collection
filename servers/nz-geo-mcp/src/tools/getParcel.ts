import { z } from "zod";
import {
  attribution,
  jsonResult,
  limitParam,
  missingCredentialError,
  responseFormatParam,
  selectFormat,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { queryVector, type LdsFeature } from "../clients/linzDataService.js";
import { summarizeGeoJsonGeometry } from "../geo.js";
import { MissingCredentialError, requireLinzCredential } from "../credentials.js";
import { LINZ_PRIMARY_PARCELS_LAYER_ID, SERVER_SLUG } from "../constants.js";

export const getParcelInputShape = {
  lat: z.number().min(-90).max(90).describe("Latitude, WGS84 decimal degrees."),
  lon: z.number().min(-180).max(180).describe("Longitude, WGS84 decimal degrees."),
  radius_m: z
    .number()
    .min(1)
    .max(500)
    .default(30)
    .describe(
      "Search radius in metres around (lat, lon). This is a nearest-features spatial query, not true " +
        "point-in-polygon containment — a small radius (the default) is usually enough to find the parcel " +
        "at a given point; widen it if you get no results near a parcel boundary.",
    ),
  max_results: limitParam(20, 5),
  response_format: responseFormatParam,
};

export const getParcelOutputShape = {
  query: z.object({ lat: z.number(), lon: z.number(), radius_m: z.number() }),
  parcels: z.array(z.record(z.string(), z.unknown())),
  count: z.number(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), license: z.string().optional(), url: z.string().optional() }),
};

const inputSchema = z.object(getParcelInputShape);

function toConcise(feature: LdsFeature) {
  const props = feature.properties;
  const surveyArea = typeof props.survey_area === "number" ? props.survey_area : null;
  const calcArea = typeof props.calc_area === "number" ? props.calc_area : null;
  const areaM2 = surveyArea ?? calcArea;
  const titles = Array.isArray(props.titles) ? props.titles : null;

  return {
    linz_parcel_id: props.id ?? null,
    appellation: props.appellation ?? null,
    parcel_intent: props.parcel_intent ?? null,
    land_district: props.land_district ?? null,
    area_ha: typeof areaM2 === "number" ? Math.round((areaM2 / 10000) * 1000) / 1000 : null,
    num_titles: titles ? titles.length : null,
    centroid: summarizeGeoJsonGeometry(feature.geometry)?.centroid ?? null,
  };
}

function toDetailed(feature: LdsFeature) {
  const props = feature.properties;
  const summary = summarizeGeoJsonGeometry(feature.geometry);
  return {
    ...toConcise(feature),
    titles: props.titles ?? null,
    affected_surveys: props.affected_surveys ?? null,
    statutory_actions: props.statutory_actions ?? null,
    topology_type: props.topology_type ?? null,
    bbox: summary?.bbox ?? null,
  };
}

export async function getParcelHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const apiKey = await requireLinzCredential(env, "LINZ_API_KEY");

    const [layer] = await queryVector({
      apiKey,
      layerIds: [LINZ_PRIMARY_PARCELS_LAYER_ID],
      lat: input.lat,
      lon: input.lon,
      radiusM: input.radius_m,
      maxResults: input.max_results,
      includeGeometry: true,
    });

    const features = layer?.features ?? [];
    const parcels = features.map((feature) => selectFormat(input.response_format, toConcise(feature), toDetailed(feature)));

    return jsonResult({
      query: { lat: input.lat, lon: input.lon, radius_m: input.radius_m },
      parcels,
      count: parcels.length,
      notice:
        parcels.length === 0
          ? "No parcels found within `radius_m` of this point. Widen `radius_m`, or double-check the " +
            "coordinates are within New Zealand and in WGS84 (lat, lon) order."
          : parcels.length >= input.max_results
            ? `Showing the maximum ${input.max_results} requested — increase \`max_results\` if you expect more overlapping parcels.`
            : "",
      attribution: attribution("LINZ Data Service — NZ Primary Parcels", {
        license: "CC BY 4.0",
        url: "https://data.linz.govt.nz/layer/50772-nz-primary-parcels/",
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
