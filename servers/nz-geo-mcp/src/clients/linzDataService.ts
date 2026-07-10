import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://data.linz.govt.nz/services/query/v1/vector.json";
const SOURCE = "LINZ Data Service";
const USER_AGENT = "nz-mcp-collection/nz-geo-mcp (+https://github.com/bradwindy/nz-mcp-collection)";

export type LdsGeometry = { type?: string; coordinates?: unknown };

export type LdsFeature = {
  properties: Record<string, unknown>;
  geometry?: LdsGeometry | null;
};

export type LdsLayerResult = {
  layerId: number;
  name: string | null;
  features: LdsFeature[];
};

export type VectorQueryParams = {
  apiKey: string;
  layerIds: number[];
  /** Decimal-degree latitude (WGS84) of the query point. */
  lat: number;
  /** Decimal-degree longitude (WGS84) of the query point. */
  lon: number;
  /** Search radius in metres around (lat, lon). Upstream valid range: 0-100000. */
  radiusM: number;
  /** Max features returned per layer. Upstream valid range: 1-100. */
  maxResults: number;
  /** Whether to ask the upstream for geometry at all (still summarized before returning to callers). */
  includeGeometry: boolean;
};

/**
 * Shape of a Koordinates-family vector query JSON response (LDS is a white-label Koordinates
 * instance — confirmed via the `server: Koordinates` response header). Documented at
 * https://help.koordinates.com/query-api-and-web-services/vector-query/ and
 * https://support.koordinates.com/hc/en-us/articles/200421184-Vector-Query. Confirmed live
 * against a real API key — the parsing below stays deliberately defensive (optional chaining,
 * empty-array fallbacks) so a minor shape mismatch degrades to "no features" rather than throwing.
 */
type VectorQueryResponse = {
  vectorQuery?: {
    layers?: Record<
      string,
      {
        name?: string;
        features?: Array<{ properties?: Record<string, unknown>; geometry?: LdsGeometry }>;
      }
    >;
  };
  // Some Koordinates deployments have been documented without the `vectorQuery` wrapper; tolerate both.
  layers?: Record<
    string,
    { name?: string; features?: Array<{ properties?: Record<string, unknown>; geometry?: LdsGeometry }> }
  >;
};

/**
 * Query one or more LDS vector layers for features near a point. This is a point+radius spatial
 * query (the upstream API has no bbox, attribute-filter, or offset-pagination mode) — see
 * https://www.linz.govt.nz/guidance/data-service/linz-data-service-guide/web-services/lds-apis-and-web-services
 * and https://help.koordinates.com/query-api-and-web-services/vector-query/.
 */
export async function queryVector(params: VectorQueryParams): Promise<LdsLayerResult[]> {
  const url = new URL(BASE_URL);
  // Confirmed live: this Koordinates-family query endpoint reads the key as `key`, not `api_key`.
  url.searchParams.set("key", params.apiKey);
  for (const layerId of params.layerIds) url.searchParams.append("layer", String(layerId));
  url.searchParams.set("x", String(params.lon));
  url.searchParams.set("y", String(params.lat));
  url.searchParams.set("radius", String(params.radiusM));
  url.searchParams.set("max_results", String(params.maxResults));
  url.searchParams.set("geometry", params.includeGeometry ? "true" : "false");

  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const body = (await response.json()) as VectorQueryResponse;
  const layers = body.vectorQuery?.layers ?? body.layers ?? {};

  return params.layerIds.map((layerId) => {
    const layer = layers[String(layerId)];
    return {
      layerId,
      name: layer?.name ?? null,
      features: (layer?.features ?? []).map((feature) => ({
        properties: feature.properties ?? {},
        geometry: feature.geometry ?? null,
      })),
    };
  });
}
