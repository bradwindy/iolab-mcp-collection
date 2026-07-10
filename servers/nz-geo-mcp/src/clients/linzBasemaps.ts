/**
 * LINZ Basemaps serves rendered tiles and styles, not queryable feature data — there is nothing
 * to "query" here. Per the collection's best-practice guidance, the right tool is one that
 * returns a correctly-formed, ready-to-use URL with the caller's key injected server-side, rather
 * than proxying tile bytes through MCP (which would be enormous and pointless for a research agent).
 *
 * URL patterns confirmed against https://www.linz.govt.nz/guidance/data-service/linz-basemaps-guide/how-use-linz-basemaps-apis
 * and (for WMTS/style specifically) a live unauthenticated-shape check of
 * https://basemaps.linz.govt.nz/v1/tiles/aerial/EPSG:3857/WMTSCapabilities.xml, which returned a
 * valid WMTS 1.0.0 capabilities document. The XYZ raster path's exact CRS segment format (bare
 * "3857"/"2193" vs "EPSG:3857"/"EPSG:2193") could not be independently re-verified after that
 * check — LINZ's own docs and multiple independent summaries consistently show the bare form for
 * XYZ, which is what's used below; confirm against your own key if tiles 404.
 */

const BASE_URL = "https://basemaps.linz.govt.nz/v1/tiles";

export type Tileset = "aerial" | "topographic";
export type Crs = "3857" | "2193";
export type RasterFormat = "webp" | "png" | "jpeg";
export type UrlKind = "xyz" | "wmts" | "style";

export type BasemapUrlParams = {
  apiKey: string;
  tileset: Tileset;
  crs: Crs;
  kind: UrlKind;
  imageFormat: RasterFormat;
};

export type BasemapUrlResult = {
  url: string;
  placeholders: string[];
  notes: string;
};

/** LINZ's vector style is only published for the topographic tileset (aerial is raster-only). */
export function supportsVectorStyle(tileset: Tileset): boolean {
  return tileset === "topographic";
}

export function buildBasemapUrl(params: BasemapUrlParams): BasemapUrlResult {
  const { apiKey, tileset, crs, kind, imageFormat } = params;

  if (kind === "style") {
    const url = `${BASE_URL}/${tileset}/EPSG:${crs}/style/${tileset}.json?api=${apiKey}`;
    return {
      url,
      placeholders: [],
      notes: "Vector StyleJSON (v8) document — pass directly to a MapLibre GL / Mapbox GL style loader.",
    };
  }

  if (kind === "wmts") {
    const url = `${BASE_URL}/${tileset}/EPSG:${crs}/WMTSCapabilities.xml?api=${apiKey}`;
    return {
      url,
      placeholders: [],
      notes: "OGC WMTS 1.0.0 capabilities document — load this URL into QGIS, ArcGIS, or any WMTS-aware client.",
    };
  }

  const url = `${BASE_URL}/${tileset}/${crs}/{z}/{x}/{y}.${imageFormat}?api=${apiKey}`;
  return {
    url,
    placeholders: ["{z}", "{x}", "{y}"],
    notes: "XYZ tile template — substitute {z}/{x}/{y} at request time (e.g. in Leaflet's L.tileLayer or MapLibre's raster source).",
  };
}
