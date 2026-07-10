import { CACHE_TTL, cached, fetchWithBackoff, UpstreamHttpError, type CacheNamespace } from "@nz-mcp/mcp-kit";
import { summarizeEsriGeometry, type GeometrySummary } from "../geo.js";

const BASE_URL = "https://gis.ecan.govt.nz/arcgis/rest/services";
const SOURCE = "Canterbury Maps (Environment Canterbury)";
const USER_AGENT = "nz-mcp-collection/nz-geo-mcp (+https://github.com/bradwindy/nz-mcp-collection)";
const SERVICES_CACHE_KEY = "nz-geo-mcp:canterbury:services:v1";
const MAX_FOLDER_DEPTH = 3;

/**
 * Thrown for an ArcGIS-level error: the REST endpoint responded 200 OK with a JSON body like
 * `{"error": {"code": 400, "message": "..."}}` (e.g. an invalid WHERE clause or layer id) rather
 * than a non-2xx HTTP status, so it can't be represented as an UpstreamHttpError.
 */
export class ArcgisQueryError extends Error {}

async function getJson<T>(url: URL): Promise<T> {
  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Service directory: recursively crawl the ArcGIS REST service directory once,
// then cache the flattened list (server structure changes rarely — new datasets
// are added far less often than they're queried).
// ---------------------------------------------------------------------------

export type CanterburyServiceEntry = {
  /** Full service path as used in REST URLs, e.g. "Public/Groundwater". */
  path: string;
  /** ArcGIS service type, e.g. "FeatureServer", "MapServer", "GeocodeServer". */
  type: string;
  folder: string | null;
};

type ArcgisDirectoryListing = {
  folders?: string[];
  services?: Array<{ name: string; type: string }>;
};

async function fetchFolder(folder: string | null, depth: number, out: CanterburyServiceEntry[]): Promise<void> {
  if (depth > MAX_FOLDER_DEPTH) return;
  const url = new URL(folder ? `${BASE_URL}/${folder}` : BASE_URL);
  url.searchParams.set("f", "pjson");
  const body = await getJson<ArcgisDirectoryListing>(url);

  for (const service of body.services ?? []) {
    out.push({ path: service.name, type: service.type, folder });
  }
  for (const subfolder of body.folders ?? []) {
    await fetchFolder(subfolder, depth + 1, out);
  }
}

/** Full directory of services across every folder on the public server, cached for a day. */
export async function listAllServices(cache: CacheNamespace): Promise<CanterburyServiceEntry[]> {
  return cached(cache, SERVICES_CACHE_KEY, CACHE_TTL.METADATA, async () => {
    const out: CanterburyServiceEntry[] = [];
    await fetchFolder(null, 0, out);
    return out;
  });
}

export function searchServices(all: CanterburyServiceEntry[], query: string): CanterburyServiceEntry[] {
  const needle = query.toLowerCase();
  return all.filter((entry) => entry.path.toLowerCase().includes(needle));
}

// ---------------------------------------------------------------------------
// Layer discovery + query for a single MapServer/FeatureServer.
// ---------------------------------------------------------------------------

export type CanterburySublayer = {
  id: number;
  name: string;
  geometryType: string | null;
  layerType: string | null;
};

export async function listLayers(servicePath: string, serviceType: string): Promise<CanterburySublayer[]> {
  const url = new URL(`${BASE_URL}/${servicePath}/${serviceType}`);
  url.searchParams.set("f", "json");
  const body = await getJson<{
    layers?: Array<{ id: number; name: string; geometryType?: string; type?: string }>;
    error?: { message: string };
  }>(url);
  if (body.error) throw new ArcgisQueryError(`${SOURCE} error listing layers: ${body.error.message}`);
  return (body.layers ?? []).map((layer) => ({
    id: layer.id,
    name: layer.name,
    geometryType: layer.geometryType ?? null,
    layerType: layer.type ?? null,
  }));
}

export type CanterburyQueryParams = {
  servicePath: string;
  serviceType: string;
  layerId: number;
  where: string;
  outFields: string;
  limit: number;
  offset: number;
  includeGeometry: boolean;
};

export type CanterburyFeature = {
  attributes: Record<string, unknown>;
  geometrySummary: GeometrySummary | null;
};

export type CanterburyQueryResult = {
  features: CanterburyFeature[];
  totalCount: number;
  exceededTransferLimit: boolean;
};

export async function queryLayer(params: CanterburyQueryParams): Promise<CanterburyQueryResult> {
  const layerBase = `${BASE_URL}/${params.servicePath}/${params.serviceType}/${params.layerId}/query`;

  const countUrl = new URL(layerBase);
  countUrl.searchParams.set("where", params.where);
  countUrl.searchParams.set("returnCountOnly", "true");
  countUrl.searchParams.set("f", "json");
  const countBody = await getJson<{ count?: number; error?: { message: string } }>(countUrl);
  if (countBody.error) throw new ArcgisQueryError(`${SOURCE} query error: ${countBody.error.message}`);

  const queryUrl = new URL(layerBase);
  queryUrl.searchParams.set("where", params.where);
  queryUrl.searchParams.set("outFields", params.outFields);
  queryUrl.searchParams.set("resultRecordCount", String(params.limit));
  queryUrl.searchParams.set("resultOffset", String(params.offset));
  queryUrl.searchParams.set("outSR", "4326");
  queryUrl.searchParams.set("returnGeometry", params.includeGeometry ? "true" : "false");
  queryUrl.searchParams.set("f", "json");
  const body = await getJson<{
    features?: Array<{ attributes?: Record<string, unknown>; geometry?: unknown }>;
    error?: { message: string };
    exceededTransferLimit?: boolean;
  }>(queryUrl);
  if (body.error) throw new ArcgisQueryError(`${SOURCE} query error: ${body.error.message}`);

  return {
    features: (body.features ?? []).map((feature) => ({
      attributes: feature.attributes ?? {},
      geometrySummary: params.includeGeometry ? summarizeEsriGeometry(feature.geometry) : null,
    })),
    totalCount: countBody.count ?? 0,
    exceededTransferLimit: body.exceededTransferLimit ?? false,
  };
}

// ---------------------------------------------------------------------------
// Address/place geocoding via the public composite locators.
// ---------------------------------------------------------------------------

const ADDRESS_LOCATOR = "Canterbury_Composite_Locator";
const PLACES_LOCATOR = "Canterbury_Places_Composite_Locator";

export type AddressCandidate = {
  matchedAddress: string;
  score: number;
  lat: number;
  lon: number;
  bbox: { min_lon: number; min_lat: number; max_lon: number; max_lat: number } | null;
  addressType: string | null;
  matchedBy: "address" | "place";
};

type GeocodeResponse = {
  candidates?: Array<{
    address: string;
    score: number;
    location: { x: number; y: number };
    extent?: { xmin: number; ymin: number; xmax: number; ymax: number };
    attributes?: { Addr_type?: string };
  }>;
  error?: { message: string };
};

async function findAddressCandidates(locator: string, singleLine: string, maxLocations: number) {
  const url = new URL(`${BASE_URL}/Locators/${locator}/GeocodeServer/findAddressCandidates`);
  url.searchParams.set("SingleLine", singleLine);
  url.searchParams.set("maxLocations", String(maxLocations));
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("f", "json");
  const body = await getJson<GeocodeResponse>(url);
  if (body.error) throw new ArcgisQueryError(`${SOURCE} geocoder error: ${body.error.message}`);
  return body.candidates ?? [];
}

/**
 * Search for a street address or named place within Canterbury. Tries the address locator
 * first (numbered street addresses; richer attributes like territory/city); falls back to the
 * places locator (parks, suburbs, landmarks) if the address locator finds nothing. Both are
 * public GeocodeServer instances on the Canterbury Maps public server — confirmed live.
 */
export async function searchAddresses(query: string, maxLocations: number): Promise<AddressCandidate[]> {
  const addressCandidates = await findAddressCandidates(ADDRESS_LOCATOR, query, maxLocations);
  if (addressCandidates.length > 0) {
    return addressCandidates.map((candidate) => toAddressCandidate(candidate, "address"));
  }
  const placeCandidates = await findAddressCandidates(PLACES_LOCATOR, query, maxLocations);
  return placeCandidates.map((candidate) => toAddressCandidate(candidate, "place"));
}

function toAddressCandidate(
  candidate: NonNullable<GeocodeResponse["candidates"]>[number],
  matchedBy: "address" | "place",
): AddressCandidate {
  return {
    matchedAddress: candidate.address,
    score: candidate.score,
    lat: candidate.location.y,
    lon: candidate.location.x,
    bbox: candidate.extent
      ? {
          min_lon: candidate.extent.xmin,
          min_lat: candidate.extent.ymin,
          max_lon: candidate.extent.xmax,
          max_lat: candidate.extent.ymax,
        }
      : null,
    addressType: candidate.attributes?.Addr_type ?? null,
    matchedBy,
  };
}
