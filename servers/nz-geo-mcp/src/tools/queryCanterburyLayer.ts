import { z } from "zod";
import {
  attribution,
  describePage,
  jsonResult,
  limitParam,
  offsetParam,
  toolError,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { ArcgisQueryError, listLayers, queryLayer } from "../clients/canterburyMaps.js";

export const queryCanterburyLayerInputShape = {
  service_path: z
    .string()
    .min(1)
    .describe("Service path from nz_geo_search_canterbury_services, e.g. 'Public/Groundwater'."),
  service_type: z
    .enum(["FeatureServer", "MapServer"])
    .describe("ArcGIS service type, as returned by nz_geo_search_canterbury_services."),
  layer_id: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Sub-layer id within the service. Omit to first discover which sub-layers exist (name, geometry type) " +
        "before querying one.",
    ),
  where: z
    .string()
    .min(1)
    .max(2000)
    .default("1=1")
    .describe("ArcGIS SQL-92 WHERE clause, e.g. \"WELL_STATUS_DESC = 'Active'\". Defaults to all features."),
  out_fields: z.string().default("*").describe("Comma-separated field names to return, or '*' for all fields."),
  limit: limitParam(200, 20),
  offset: offsetParam,
  include_geometry: z
    .boolean()
    .default(false)
    .describe("If true, include each feature's centroid and bounding box (never raw rings/paths)."),
};

export const queryCanterburyLayerOutputShape = {
  service_path: z.string(),
  service_type: z.string(),
  layer_id: z.number().nullable(),
  layers: z.array(z.record(z.string(), z.unknown())).optional(),
  items: z.array(z.record(z.string(), z.unknown())).optional(),
  total_count: z.number().optional(),
  has_more: z.boolean().optional(),
  next_offset: z.number().nullable().optional(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(queryCanterburyLayerInputShape);

export async function queryCanterburyLayerHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const attributionInfo = attribution("Canterbury Maps (Environment Canterbury)", {
    url: "https://gis.ecan.govt.nz/arcgis/rest/services",
  });

  try {
    if (input.layer_id === undefined) {
      const layers = await listLayers(input.service_path, input.service_type);
      return jsonResult({
        service_path: input.service_path,
        service_type: input.service_type,
        layer_id: null,
        layers: layers.map((layer) => ({
          layer_id: layer.id,
          name: layer.name,
          geometry_type: layer.geometryType,
          layer_type: layer.layerType,
        })),
        notice: "Pass one of these `layer_id` values to query its features.",
        attribution: attributionInfo,
      });
    }

    const result = await queryLayer({
      servicePath: input.service_path,
      serviceType: input.service_type,
      layerId: input.layer_id,
      where: input.where,
      outFields: input.out_fields,
      limit: input.limit,
      offset: input.offset,
      includeGeometry: input.include_geometry,
    });

    const page = describePage({ returned: result.features.length, total_count: result.totalCount, offset: input.offset });
    const items = result.features.map((feature) => {
      const record: Record<string, unknown> = { ...feature.attributes };
      if (input.include_geometry) record.geometry_summary = feature.geometrySummary;
      return record;
    });

    const noticeParts: string[] = [];
    const baseNotice = truncationNotice(
      input.offset + result.features.length,
      result.totalCount,
      "Narrow with `where`, or page with `limit`/`offset`.",
    );
    if (baseNotice) noticeParts.push(baseNotice);
    if (result.exceededTransferLimit) {
      noticeParts.push("The upstream server capped this single request below the requested `limit`; page with `offset` to see more.");
    }

    return jsonResult({
      service_path: input.service_path,
      service_type: input.service_type,
      layer_id: input.layer_id,
      items,
      ...page,
      notice: noticeParts.join(" "),
      attribution: attributionInfo,
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    if (error instanceof ArcgisQueryError) {
      return toolError(
        error.message,
        "Check `where` is valid ArcGIS SQL-92 and `layer_id` exists (omit `layer_id` to list valid ids).",
      );
    }
    throw error;
  }
}
