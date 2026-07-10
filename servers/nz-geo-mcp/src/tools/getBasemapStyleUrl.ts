import { z } from "zod";
import { attribution, jsonResult, missingCredentialError, toolError, type ToolTextResult } from "@nz-mcp/mcp-kit";
import { buildBasemapUrl, supportsVectorStyle } from "../clients/linzBasemaps.js";
import { MissingCredentialError, requireLinzCredential } from "../credentials.js";
import { SERVER_SLUG } from "../constants.js";

export const getBasemapStyleUrlInputShape = {
  tileset: z
    .enum(["aerial", "topographic"])
    .default("aerial")
    .describe("Which LINZ basemap to build a URL for: 'aerial' imagery or the 'topographic' map."),
  kind: z
    .enum(["xyz", "wmts", "style"])
    .default("xyz")
    .describe(
      "'xyz' returns a {z}/{x}/{y} raster/vector tile URL template for web/mobile clients (Leaflet, MapLibre). " +
        "'wmts' returns an OGC WMTS capabilities document URL for GIS clients (QGIS, ArcGIS). " +
        "'style' returns a MapLibre/Mapbox StyleJSON URL (topographic tileset only).",
    ),
  crs: z
    .enum(["3857", "2193"])
    .default("3857")
    .describe("Coordinate reference system: 3857 (Web Mercator, most web maps) or 2193 (NZTM2000, NZ GIS convention)."),
  image_format: z
    .enum(["webp", "png", "jpeg"])
    .default("webp")
    .describe("Raster tile image format. Only applies to kind: 'xyz' on the aerial tileset."),
  reveal_key: z
    .boolean()
    .default(false)
    .describe(
      "If true, embed your real LINZ Basemaps key in the returned URL so it's immediately usable in a map " +
        "client. Defaults to false (a placeholder is used instead), since the real key would otherwise appear " +
        "verbatim in this conversation. Only set true right before handing the URL to a map renderer.",
    ),
};

export const getBasemapStyleUrlOutputShape = {
  url: z.string(),
  placeholders: z.array(z.string()),
  notes: z.string(),
  rate_limit_notice: z.string(),
  attribution: z.object({ source: z.string(), license: z.string().optional(), url: z.string().optional() }),
};

const inputSchema = z.object(getBasemapStyleUrlInputShape);

export async function getBasemapStyleUrlHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  if (input.kind === "style" && !supportsVectorStyle(input.tileset)) {
    return toolError(
      "Vector StyleJSON is only published for the 'topographic' tileset — 'aerial' is raster imagery only.",
      "Use tileset: 'topographic' with kind: 'style', or kind: 'xyz'/'wmts' for aerial imagery.",
    );
  }

  try {
    const apiKey = await requireLinzCredential(env, "LINZ_BASEMAPS_API_KEY");
    const built = buildBasemapUrl({
      apiKey: input.reveal_key ? apiKey : "YOUR_LINZ_BASEMAPS_API_KEY",
      tileset: input.tileset,
      crs: input.crs,
      kind: input.kind,
      imageFormat: input.image_format,
    });

    return jsonResult({
      url: built.url,
      placeholders: built.placeholders,
      notes: input.reveal_key
        ? built.notes
        : `${built.notes} The URL above has a placeholder instead of your real key — call this tool again ` +
          "with reveal_key: true to get a ready-to-use URL (only do this right before handing it to a map " +
          "renderer, since the real key will then appear in this conversation).",
      rate_limit_notice:
        "Standard (no-registration) LINZ Basemaps keys allow up to 1,000 tile requests/minute and " +
        "1,000,000/month, and expire after 90 days (a fresh one is issued automatically when you next visit " +
        "basemaps.linz.govt.nz). For unlimited production use, request a non-expiring Developer key from " +
        "basemaps@linz.govt.nz.",
      attribution: attribution("LINZ Basemaps", {
        license: "CC BY 4.0",
        url: "https://basemaps.linz.govt.nz/",
      }),
    });
  } catch (error) {
    if (error instanceof MissingCredentialError) {
      return missingCredentialError(SERVER_SLUG, error.keyName, env.PORTAL_URL);
    }
    throw error;
  }
}
