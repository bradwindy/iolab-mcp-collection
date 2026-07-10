import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://api.geonet.org.nz";
const SOURCE = "GeoNet API";
const USER_AGENT = "nz-mcp-collection/nz-environment-mcp (+https://github.com/bradwindy/nz-mcp-collection)";
const GEOJSON_ACCEPT = "application/vnd.geo+json;version=2";

type GeoJsonFeature<P> = {
  type: "Feature";
  geometry: { type: string; coordinates: [number, number] };
  properties: P;
};

type GeoJsonFeatureCollection<P> = {
  type: "FeatureCollection";
  features: Array<GeoJsonFeature<P>>;
};

type IntensityFeatureCollection = GeoJsonFeatureCollection<IntensityProperties> & {
  count?: number;
  count_mmi?: Record<string, number>;
};

async function getGeoJson<T>(path: string, query: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  const response = await fetchWithBackoff(url, {
    headers: { Accept: GEOJSON_ACCEPT, "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return (await response.json()) as T;
}

/** Flatten a GeoJSON Point feature into its properties plus longitude/latitude. */
function toPoint<P>(feature: GeoJsonFeature<P>): P & { longitude: number; latitude: number } {
  const [longitude, latitude] = feature.geometry.coordinates;
  return { ...feature.properties, longitude, latitude };
}

export type QuakeQuality = "best" | "preliminary" | "automatic" | "deleted";

export type QuakeProperties = {
  publicID: string;
  time: string;
  depth: number;
  magnitude: number;
  locality: string;
  mmi: number;
  quality: QuakeQuality;
};

export type Quake = QuakeProperties & { longitude: number; latitude: number };

/**
 * Recent quakes that may have caused shaking at or above `mmi` in the NZ region.
 * Per GeoNet's own docs this returns up to the 100 most recent matching quakes from
 * the last 365 days — it is not a general historical archive search (use the FDSN
 * event service for arbitrary date ranges).
 */
export async function getRecentQuakes(mmi: number): Promise<Quake[]> {
  const data = await getGeoJson<GeoJsonFeatureCollection<QuakeProperties>>("/quake", { MMI: String(mmi) });
  return data.features.map(toPoint);
}

export type QuakeHistoryProperties = QuakeProperties & { modificationTime: string };
export type QuakeHistoryEntry = QuakeHistoryProperties & { longitude: number; latitude: number };

/** Location/magnitude revision history for a single quake. Not all quakes have one. */
export async function getQuakeHistory(publicId: string): Promise<QuakeHistoryEntry[]> {
  const data = await getGeoJson<GeoJsonFeatureCollection<QuakeHistoryProperties>>(
    `/quake/history/${encodeURIComponent(publicId)}`,
  );
  return data.features.map(toPoint);
}

export type VolcanoAlertProperties = {
  volcanoID: string;
  volcanoTitle: string;
  level: number;
  acc: string;
  activity: string;
  hazards: string;
};

export type VolcanoAlert = VolcanoAlertProperties & { longitude: number; latitude: number };

/** Current Volcanic Alert Level for every monitored NZ volcano. */
export async function getVolcanoAlertLevels(): Promise<VolcanoAlert[]> {
  const data = await getGeoJson<GeoJsonFeatureCollection<VolcanoAlertProperties>>("/volcano/val");
  return data.features.map(toPoint);
}

export type IntensityType = "measured" | "reported";
export type IntensityAggregation = "max" | "median";

export type IntensityProperties = {
  mmi: number;
  count?: number;
  count_mmi?: Record<string, number>;
};

export type IntensityPoint = IntensityProperties & { longitude: number; latitude: number };

export type IntensityResult = {
  points: IntensityPoint[];
  count: number;
  count_mmi: Record<string, number>;
};

/**
 * Shaking intensity: `measured` (instrument readings) or `reported` (felt reports).
 * Without a `publicId`, results cover the last 60 minutes. With one, results cover a
 * time window around that quake (only valid for type=reported).
 */
export async function getShakingIntensity(params: {
  type: IntensityType;
  aggregation?: IntensityAggregation;
  publicId?: string;
}): Promise<IntensityResult> {
  const data = await getGeoJson<IntensityFeatureCollection>("/intensity", {
    type: params.type,
    ...(params.aggregation ? { aggregation: params.aggregation } : {}),
    ...(params.publicId ? { publicID: params.publicId } : {}),
  });
  return {
    points: data.features.map(toPoint),
    count: data.count ?? data.features.length,
    count_mmi: data.count_mmi ?? {},
  };
}
