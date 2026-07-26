import { fetchWithBackoff, UpstreamHttpError } from "@iolab/mcp-kit";

const REALTIME_BASE = "https://api.at.govt.nz/realtime/legacy";
const GTFS_BASE = "https://api.at.govt.nz/gtfs/v3";
export const SOURCE = "Auckland Transport";
const USER_AGENT = "nz-mcp-collection/nz-transport-mcp (+https://github.com/bradwindy/nz-mcp-collection)";

// --- GTFS-realtime (confirmed live via unauthenticated probes returning Azure APIM's
// "missing subscription key" 401 body, not a 404, against api.at.govt.nz):
//   /realtime/legacy/vehiclelocations, /realtime/legacy/tripupdates, /realtime/legacy/servicealerts
// Field shapes below follow the official GTFS-realtime JSON mapping (gtfs.org/documentation/realtime/reference),
// which AT's "Realtime Compat API" (its own label for these /legacy endpoints) implements.

export type GtfsRtTripDescriptor = {
  trip_id?: string;
  route_id?: string;
  direction_id?: number;
  start_time?: string;
  start_date?: string;
  schedule_relationship?: string;
};

export type GtfsRtVehicleDescriptor = {
  id?: string;
  label?: string;
  license_plate?: string;
};

export type GtfsRtPosition = {
  latitude: number;
  longitude: number;
  bearing?: number;
  speed?: number;
  odometer?: number;
};

export type GtfsRtTranslation = { text: string; language?: string };

export type GtfsRtTranslatedString = {
  // See toArray() below: may collapse to a single object when there's exactly one translation
  // (the common case for NZ-only alerts, which only ever have an English string).
  translation?: GtfsRtTranslation | GtfsRtTranslation[];
};

export type GtfsRtEntitySelector = {
  agency_id?: string;
  route_id?: string;
  route_type?: number;
  trip?: GtfsRtTripDescriptor;
  stop_id?: string;
};

export type GtfsRtActivePeriod = { start?: number | string; end?: number | string };

export type GtfsRtAlert = {
  // See toArray() below: AT's serializer collapses a single-item repeated field to a bare
  // object rather than a one-element array, so these may arrive as a lone object.
  active_period?: GtfsRtActivePeriod | GtfsRtActivePeriod[];
  informed_entity?: GtfsRtEntitySelector | GtfsRtEntitySelector[];
  cause?: string;
  effect?: string;
  header_text?: GtfsRtTranslatedString;
  description_text?: GtfsRtTranslatedString;
  severity_level?: string;
  url?: GtfsRtTranslatedString;
};

export type GtfsRtVehiclePosition = {
  trip?: GtfsRtTripDescriptor;
  vehicle?: GtfsRtVehicleDescriptor;
  position?: GtfsRtPosition;
  current_stop_sequence?: number;
  stop_id?: string;
  current_status?: string;
  timestamp?: number | string;
  congestion_level?: string;
  occupancy_status?: string;
};

export type GtfsRtStopTimeEvent = { delay?: number; time?: number | string; uncertainty?: number };

export type GtfsRtStopTimeUpdate = {
  stop_sequence?: number;
  stop_id?: string;
  arrival?: GtfsRtStopTimeEvent;
  departure?: GtfsRtStopTimeEvent;
  schedule_relationship?: string;
};

export type GtfsRtTripUpdate = {
  trip?: GtfsRtTripDescriptor;
  vehicle?: GtfsRtVehicleDescriptor;
  // See toArray() below: AT's serializer collapses a single-item repeated field to a bare
  // object rather than a one-element array, so this may arrive as a lone object.
  stop_time_update?: GtfsRtStopTimeUpdate | GtfsRtStopTimeUpdate[];
  timestamp?: number | string;
  delay?: number;
};

/**
 * Confirmed live 2026-07-10 (a trip_update with exactly one pending stop came back as a bare
 * `stop_time_update` object rather than `[{...}]`): AT's realtime JSON serializer collapses a
 * single-item repeated field instead of keeping the one-element array the GTFS-realtime JSON
 * mapping implies. Use this wherever a GTFS-RT field is nominally "repeated" — informed_entity,
 * active_period, stop_time_update — so a count of exactly one doesn't silently drop data or
 * throw when callers `.map`/`.filter`/`.slice` it.
 */
export function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export type GtfsRtFeedEntity<K extends string, T> = { id: string; is_deleted?: boolean } & { [P in K]?: T };

export type GtfsRtFeedMessage<E> = {
  header: { gtfs_realtime_version?: string; timestamp?: number | string; incrementality?: string };
  entity: E[];
};

export type AlertFeedEntity = GtfsRtFeedEntity<"alert", GtfsRtAlert>;
export type VehicleFeedEntity = GtfsRtFeedEntity<"vehicle", GtfsRtVehiclePosition>;
export type TripUpdateFeedEntity = GtfsRtFeedEntity<"trip_update", GtfsRtTripUpdate>;

function atHeaders(subscriptionKey: string): HeadersInit {
  return {
    "Ocp-Apim-Subscription-Key": subscriptionKey,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

async function getJson<T>(url: string, subscriptionKey: string): Promise<T> {
  const response = await fetchWithBackoff(url, { headers: atHeaders(subscriptionKey) });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return (await response.json()) as T;
}

/**
 * Confirmed live 2026-07-10: the "legacy" realtime endpoints wrap the GTFS-realtime JSON
 * message in an outer `{status, response}` envelope — `{"status":"OK","response":{"header":
 * {...},"entity":[...]}}` — rather than returning `{header, entity}` at the top level as the
 * official GTFS-realtime JSON mapping would suggest. Unwrap it here so callers see the plain
 * FeedMessage shape.
 */
async function getRealtimeFeed<E>(url: string, subscriptionKey: string): Promise<GtfsRtFeedMessage<E>> {
  const wrapped = await getJson<{ status?: string; response?: GtfsRtFeedMessage<E> }>(url, subscriptionKey);
  return wrapped.response ?? { header: {}, entity: [] };
}

export async function getServiceAlerts(subscriptionKey: string): Promise<GtfsRtFeedMessage<AlertFeedEntity>> {
  return getRealtimeFeed(`${REALTIME_BASE}/servicealerts`, subscriptionKey);
}

export async function getVehiclePositions(subscriptionKey: string): Promise<GtfsRtFeedMessage<VehicleFeedEntity>> {
  return getRealtimeFeed(`${REALTIME_BASE}/vehiclelocations`, subscriptionKey);
}

export async function getTripUpdates(subscriptionKey: string): Promise<GtfsRtFeedMessage<TripUpdateFeedEntity>> {
  return getRealtimeFeed(`${REALTIME_BASE}/tripupdates`, subscriptionKey);
}

// --- Static GTFS (JSON:API). Confirmed live and registered (401-not-404) at:
//   GET /gtfs/v3/stops?filter[date]=YYYY-MM-DD   (date filter required — omitting it 404s)
//   GET /gtfs/v3/routes                          (no required filter)
// via the published `airatech/mcp-auckland-transport` client (github.com/airatech/mcp-auckland-transport,
// src/at_service.py + src/gtfs_types.py), whose Stop attributes we mirror exactly. That project only
// implements stops; the Route attribute names below are inferred by analogy with the confirmed Stop
// shape and the canonical GTFS static `routes.txt` column names (gtfs.org/documentation/schedule/reference/#routestxt)
// since actually calling `/gtfs/v3/routes` requires a subscription key we cannot obtain — treat unknown
// fields defensively (all optional, all passed through).

export type JsonApiResource<A> = { type: string; id: string; attributes: A };
export type JsonApiCollection<A> = { data: Array<JsonApiResource<A>> };

/** Confirmed field names (github.com/airatech/mcp-auckland-transport, src/gtfs_types.py:StopAttributes). */
export type GtfsStopAttributes = {
  stop_id: string;
  stop_code?: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  location_type?: number;
  wheelchair_boarding?: number;
};

/** Inferred by analogy with confirmed Stop shape + canonical GTFS routes.txt columns — not independently verified. */
export type GtfsRouteAttributes = {
  route_id?: string;
  route_short_name?: string;
  route_long_name?: string;
  route_type?: number;
  route_color?: string;
  route_text_color?: string;
  agency_id?: string;
  route_desc?: string;
  route_url?: string;
};

export async function getAllStops(
  subscriptionKey: string,
  journeyDateIso: string,
): Promise<JsonApiCollection<GtfsStopAttributes>> {
  // Deliberately not URLSearchParams: the confirmed-working request (see the module comment above)
  // uses literal `filter[date]=`, and we only ever interpolate a machine-generated ISO date here.
  return getJson(`${GTFS_BASE}/stops?filter[date]=${encodeURIComponent(journeyDateIso)}`, subscriptionKey);
}

export async function getAllRoutes(subscriptionKey: string): Promise<JsonApiCollection<GtfsRouteAttributes>> {
  return getJson(`${GTFS_BASE}/routes`, subscriptionKey);
}
