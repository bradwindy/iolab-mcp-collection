import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

// NZTA's Traffic and Travel API publishes a WADL (curl 'https://trafficnz.info/service/traffic/rest/4?_wadl')
// but the WADL's per-parameter docs are unreliable: `events/byregion/{region}` and `cameras/byregion/{region}`
// both document `region` as "region name", but live testing shows only the numeric NZTA region id resolves —
// `.../events/byregion/Otago/-1` and `.../events/byregion/otago/-1` both return `{"response":""}` (empty),
// while `.../events/byregion/13/-1` returns real Otago events. We resolve names to ids ourselves
// (see constants.ts NZTA_TRAFFIC_REGIONS) rather than trusting the documented parameter type.
//
// zoomlevel `-1` is documented as "no geom" and confirmed live: road events fetched this way never carry
// the optional `geometry` string field, so there is nothing to strip for the geospatial-truncation rule.

const BASE = "https://trafficnz.info/service/traffic/rest/4";
export const SOURCE = "Waka Kotahi NZTA Traffic and Travel API";
export const CAMERA_IMAGE_HOST = "https://trafficnz.info";
const USER_AGENT = "nz-mcp-collection/nz-transport-mcp (+https://mcp.example.invalid)";

export type NztaRegionRef = { id?: string; name?: string };
export type NztaWayRef = { id?: string; name?: string };
export type NztaJourneyRef = {
  id?: string;
  name?: string;
  startLatitude?: number;
  startLongitude?: number;
  endLatitude?: number;
  endLongitude?: number;
};

export type NztaRoadEvent = {
  id: number;
  eventType?: string;
  eventDescription?: string;
  eventComments?: string;
  impact?: string;
  status?: string;
  planned: boolean;
  startDate?: string;
  endDate?: string;
  eventCreated?: string;
  eventModified?: string;
  expectedResolution?: string;
  locationArea?: string;
  locations?: string[];
  alternativeRoute?: string;
  informationSource?: string;
  supplier?: string;
  region?: NztaRegionRef;
  way?: NztaWayRef;
  journey?: NztaJourneyRef;
};

export type NztaCamera = {
  id: number;
  name?: string;
  description?: string;
  direction?: string;
  group?: string;
  highway?: string;
  latitude: number;
  longitude: number;
  imageUrl?: string;
  thumbUrl?: string;
  viewUrl?: string;
  offline: boolean;
  underMaintenance: boolean;
  sortOrder?: number;
  region?: NztaRegionRef;
  way?: NztaWayRef;
  journey?: NztaJourneyRef;
};

/** The API returns `"response": ""` (an empty string, not an object) instead of an empty list when there are no matches. */
type NztaEnvelope<K extends string, T> = { response: ({ [P in K]?: T[] } & Record<string, unknown>) | "" };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetchWithBackoff(`${BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return (await response.json()) as T;
}

export async function getRoadEvents(regionId?: number): Promise<NztaRoadEvent[]> {
  const path = regionId ? `/events/byregion/${regionId}/-1` : `/events/all/-1`;
  const body = await getJson<NztaEnvelope<"roadevent", NztaRoadEvent>>(path);
  if (!body.response || typeof body.response !== "object") return [];
  return body.response.roadevent ?? [];
}

export async function getCameras(regionId?: number): Promise<NztaCamera[]> {
  const path = regionId ? `/cameras/byregion/${regionId}` : `/cameras/all`;
  const body = await getJson<NztaEnvelope<"camera", NztaCamera>>(path);
  if (!body.response || typeof body.response !== "object") return [];
  return body.response.camera ?? [];
}
