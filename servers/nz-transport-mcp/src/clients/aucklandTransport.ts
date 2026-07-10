import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const REALTIME_BASE = "https://api.at.govt.nz/realtime/legacy";
const GTFS_BASE = "https://api.at.govt.nz/gtfs/v3";
export const SOURCE = "Auckland Transport";
const USER_AGENT = "nz-mcp-collection/nz-transport-mcp (+https://mcp.iolab.nz)";

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

export type GtfsRtTranslatedString = {
  translation?: Array<{ text: string; language?: string }>;
};

export type GtfsRtEntitySelector = {
  agency_id?: string;
  route_id?: string;
  route_type?: number;
  trip?: GtfsRtTripDescriptor;
  stop_id?: string;
};

export type GtfsRtAlert = {
  active_period?: Array<{ start?: number | string; end?: number | string }>;
  informed_entity?: GtfsRtEntitySelector[];
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
  stop_time_update?: GtfsRtStopTimeUpdate[];
  timestamp?: number | string;
  delay?: number;
};

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

export async function getServiceAlerts(subscriptionKey: string): Promise<GtfsRtFeedMessage<AlertFeedEntity>> {
  return getJson(`${REALTIME_BASE}/servicealerts`, subscriptionKey);
}

export async function getVehiclePositions(subscriptionKey: string): Promise<GtfsRtFeedMessage<VehicleFeedEntity>> {
  return getJson(`${REALTIME_BASE}/vehiclelocations`, subscriptionKey);
}

export async function getTripUpdates(subscriptionKey: string): Promise<GtfsRtFeedMessage<TripUpdateFeedEntity>> {
  return getJson(`${REALTIME_BASE}/tripupdates`, subscriptionKey);
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
