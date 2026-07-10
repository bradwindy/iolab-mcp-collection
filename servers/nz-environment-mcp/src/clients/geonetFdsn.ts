import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://service.geonet.org.nz/fdsnws";
const SOURCE = "GeoNet FDSN Web Services";
const USER_AGENT = "nz-mcp-collection/nz-environment-mcp (+https://github.com/bradwindy/nz-mcp-collection)";

/** [west, south, east, north] in decimal degrees. */
export type BoundingBox = [number, number, number, number];

function setIfDefined(url: URL, key: string, value: string | number | undefined): void {
  if (value !== undefined) url.searchParams.set(key, String(value));
}

/** Parse GeoNet's pipe-delimited `format=text` tables. Returns [] for an empty/204 body. */
function splitPipeRows(text: string): string[][] {
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  return lines.map((line) => line.split("|").map((cell) => cell.trim()));
}

export type FdsnQuakeRecord = {
  eventId: string;
  time: string;
  latitude: number;
  longitude: number;
  depthKm: number;
  author: string;
  catalog: string;
  contributor: string;
  contributorId: string;
  magnitudeType: string;
  magnitude: number;
  magnitudeAuthor: string;
  locationName: string;
  eventType: string;
};

/**
 * Archival/historical earthquake search via the FDSN event service. Unlike the GeoNet
 * `/quake` feed, this covers any date range but is capped at 10,000 events per query
 * by GeoNet and has no server-side limit/offset — narrow with tighter filters if a
 * query is likely to be near that cap. The near-real-time (NRT) index only covers the
 * last ~8 days; anything older comes from the archive, which lags live events by ~7 days.
 */
export async function searchQuakeHistory(params: {
  startTime: string;
  endTime: string;
  minMagnitude?: number;
  maxMagnitude?: number;
  minDepth?: number;
  maxDepth?: number;
  bbox?: BoundingBox;
  eventType?: string;
  orderBy?: "time" | "time-asc" | "magnitude" | "magnitude-asc";
}): Promise<FdsnQuakeRecord[]> {
  const url = new URL(`${BASE_URL}/event/1/query`);
  url.searchParams.set("format", "text");
  url.searchParams.set("starttime", params.startTime);
  url.searchParams.set("endtime", params.endTime);
  setIfDefined(url, "minmagnitude", params.minMagnitude);
  setIfDefined(url, "maxmagnitude", params.maxMagnitude);
  setIfDefined(url, "mindepth", params.minDepth);
  setIfDefined(url, "maxdepth", params.maxDepth);
  setIfDefined(url, "eventtype", params.eventType);
  setIfDefined(url, "orderby", params.orderBy);
  if (params.bbox) {
    const [west, south, east, north] = params.bbox;
    url.searchParams.set("minlongitude", String(west));
    url.searchParams.set("minlatitude", String(south));
    url.searchParams.set("maxlongitude", String(east));
    url.searchParams.set("maxlatitude", String(north));
  }

  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT } });
  // FDSN services return 204 (default `nodata`) for a query that matched nothing.
  if (response.status === 204) return [];
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const rows = splitPipeRows(await response.text());
  return rows.map((c) => ({
    eventId: c[0] ?? "",
    time: c[1] ?? "",
    latitude: Number(c[2]),
    longitude: Number(c[3]),
    depthKm: Number(c[4]),
    author: c[5] ?? "",
    catalog: c[6] ?? "",
    contributor: c[7] ?? "",
    contributorId: c[8] ?? "",
    magnitudeType: c[9] ?? "",
    magnitude: Number(c[10]),
    magnitudeAuthor: c[11] ?? "",
    locationName: c[12] ?? "",
    eventType: c[13] ?? "",
  }));
}

export type FdsnStationRecord = {
  network: string;
  station: string;
  latitude: number;
  longitude: number;
  elevationM: number;
  siteName: string;
  startTime: string;
  endTime: string;
};

/** Station metadata search via the FDSN station service (network/station level, not per-channel). */
export async function searchStations(params: {
  network?: string;
  station?: string;
  bbox?: BoundingBox;
}): Promise<FdsnStationRecord[]> {
  const url = new URL(`${BASE_URL}/station/1/query`);
  url.searchParams.set("format", "text");
  url.searchParams.set("level", "station");
  setIfDefined(url, "network", params.network);
  setIfDefined(url, "station", params.station);
  if (params.bbox) {
    const [west, south, east, north] = params.bbox;
    url.searchParams.set("minlongitude", String(west));
    url.searchParams.set("minlatitude", String(south));
    url.searchParams.set("maxlongitude", String(east));
    url.searchParams.set("maxlatitude", String(north));
  }

  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT } });
  if (response.status === 204) return [];
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const rows = splitPipeRows(await response.text());
  return rows.map((c) => ({
    network: c[0] ?? "",
    station: c[1] ?? "",
    latitude: Number(c[2]),
    longitude: Number(c[3]),
    elevationM: Number(c[4]),
    siteName: c[5] ?? "",
    startTime: c[6] ?? "",
    endTime: c[7] ?? "",
  }));
}

/**
 * Build (but do not fetch) a miniSEED waveform download URL from the FDSN dataselect
 * service. Waveform bodies are binary and can be large, so this server never inlines
 * them — callers fetch the URL themselves with whatever tool suits (curl, ObsPy, etc.).
 */
export function buildWaveformUrl(params: {
  network: string;
  station: string;
  location?: string;
  channel: string;
  startTime: string;
  endTime: string;
}): string {
  const url = new URL(`${BASE_URL}/dataselect/1/query`);
  url.searchParams.set("network", params.network);
  url.searchParams.set("station", params.station);
  setIfDefined(url, "location", params.location);
  url.searchParams.set("channel", params.channel);
  url.searchParams.set("starttime", params.startTime);
  url.searchParams.set("endtime", params.endTime);
  url.searchParams.set("format", "miniseed");
  return url.toString();
}
