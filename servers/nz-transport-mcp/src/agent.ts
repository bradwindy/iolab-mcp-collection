import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS, type OAuthProps } from "@iolab/mcp-kit";
import {
  getRealtimeAlertsHandler,
  getRealtimeAlertsInputShape,
  getRealtimeAlertsOutputShape,
} from "./tools/getRealtimeAlerts.js";
import {
  getVehiclePositionsHandler,
  getVehiclePositionsInputShape,
  getVehiclePositionsOutputShape,
} from "./tools/getVehiclePositions.js";
import { getTripUpdatesHandler, getTripUpdatesInputShape, getTripUpdatesOutputShape } from "./tools/getTripUpdates.js";
import {
  searchGtfsStopsHandler,
  searchGtfsStopsInputShape,
  searchGtfsStopsOutputShape,
} from "./tools/searchGtfsStops.js";
import {
  searchGtfsRoutesHandler,
  searchGtfsRoutesInputShape,
  searchGtfsRoutesOutputShape,
} from "./tools/searchGtfsRoutes.js";
import {
  searchHighwayIncidentsHandler,
  searchHighwayIncidentsInputShape,
  searchHighwayIncidentsOutputShape,
} from "./tools/searchHighwayIncidents.js";
import {
  getHighwayCamerasHandler,
  getHighwayCamerasInputShape,
  getHighwayCamerasOutputShape,
} from "./tools/getHighwayCameras.js";
import { getTrafficCountsHandler, getTrafficCountsInputShape, getTrafficCountsOutputShape } from "./tools/getTrafficCounts.js";
import {
  searchVehicleFleetHandler,
  searchVehicleFleetInputShape,
  searchVehicleFleetOutputShape,
} from "./tools/searchVehicleFleet.js";
import {
  getLicenceHolderStatsHandler,
  getLicenceHolderStatsInputShape,
  getLicenceHolderStatsOutputShape,
} from "./tools/getLicenceHolderStats.js";

export class NzTransportMcp extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({ name: "nz-transport-mcp", version: "0.1.0" });

  async init() {
    // --- Auckland Transport (requires the AT_SUBSCRIPTION_KEY credential) ---

    this.server.registerTool(
      "nz_transport_get_realtime_alerts",
      {
        description:
          "Get current Auckland Transport GTFS-realtime service alerts (disruptions, detours, cancellations), " +
          "optionally filtered to one route. Requires an Auckland Transport subscription key.",
        inputSchema: getRealtimeAlertsInputShape,
        outputSchema: getRealtimeAlertsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Realtime Service Alerts" },
      },
      (rawInput) => getRealtimeAlertsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_transport_get_vehicle_positions",
      {
        description:
          "Get live Auckland Transport vehicle positions (bus/train/ferry location, bearing, speed), " +
          "optionally filtered to one route. Requires an Auckland Transport subscription key.",
        inputSchema: getVehiclePositionsInputShape,
        outputSchema: getVehiclePositionsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Vehicle Positions" },
      },
      (rawInput) => getVehiclePositionsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_transport_get_trip_updates",
      {
        description:
          "Get live Auckland Transport trip updates (predicted arrival/departure delays per stop for in-progress " +
          "trips), optionally filtered to one route. Requires an Auckland Transport subscription key.",
        inputSchema: getTripUpdatesInputShape,
        outputSchema: getTripUpdatesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Trip Updates" },
      },
      (rawInput) => getTripUpdatesHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_transport_search_gtfs_stops",
      {
        description:
          "Search Auckland Transport's static GTFS stop directory by name. Requires an Auckland Transport " +
          "subscription key.",
        inputSchema: searchGtfsStopsInputShape,
        outputSchema: searchGtfsStopsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search GTFS Stops" },
      },
      (rawInput) => searchGtfsStopsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_transport_search_gtfs_routes",
      {
        description:
          "Search Auckland Transport's static GTFS route directory by short or long name. Requires an Auckland " +
          "Transport subscription key.",
        inputSchema: searchGtfsRoutesInputShape,
        outputSchema: searchGtfsRoutesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search GTFS Routes" },
      },
      (rawInput) => searchGtfsRoutesHandler(rawInput, this.env),
    );

    // --- NZTA Traffic and Travel API (public, no key) ---

    this.server.registerTool(
      "nz_transport_search_highway_incidents",
      {
        description:
          "Search current state highway incidents (crashes, roadworks, closures, hazards) from Waka Kotahi " +
          "NZTA's national Traffic and Travel feed, optionally filtered to one region. No API key required.",
        inputSchema: searchHighwayIncidentsInputShape,
        outputSchema: searchHighwayIncidentsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Highway Incidents" },
      },
      (rawInput) => searchHighwayIncidentsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_transport_get_highway_cameras",
      {
        description:
          "Get Waka Kotahi NZTA's national state highway traffic camera directory (location, status, still-image " +
          "URL), optionally filtered to one region. No API key required.",
        inputSchema: getHighwayCamerasInputShape,
        outputSchema: getHighwayCamerasOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Highway Cameras" },
      },
      (rawInput) => getHighwayCamerasHandler(rawInput, this.env),
    );

    // --- NZTA open ArcGIS datasets (public, no key) ---

    this.server.registerTool(
      "nz_transport_get_traffic_counts",
      {
        description:
          "Get daily state highway traffic volumes from Waka Kotahi NZTA's telemetry count-site network, " +
          "filterable by site reference, region, and date range. No API key required.",
        inputSchema: getTrafficCountsInputShape,
        outputSchema: getTrafficCountsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get State Highway Traffic Counts" },
      },
      getTrafficCountsHandler,
    );

    this.server.registerTool(
      "nz_transport_search_vehicle_fleet",
      {
        description:
          "Search Waka Kotahi NZTA's monthly Motor Vehicle Register snapshot of the NZ vehicle fleet by make, " +
          "fuel/motive-power type, or owner's territorial authority. This is a point-in-time snapshot, not a " +
          "live registry: VINs are truncated to 11 characters and owner detail is limited to territorial " +
          "authority for privacy. No API key required.",
        inputSchema: searchVehicleFleetInputShape,
        outputSchema: searchVehicleFleetOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Vehicle Fleet Register" },
      },
      searchVehicleFleetHandler,
    );

    this.server.registerTool(
      "nz_transport_get_licence_holder_stats",
      {
        description:
          "Get Waka Kotahi NZTA's aggregate driver licence holder statistics by region, licence class, licence " +
          "stage, age group, and financial year. This is an aggregate count dataset, not individual licence " +
          "records. No API key required.",
        inputSchema: getLicenceHolderStatsInputShape,
        outputSchema: getLicenceHolderStatsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Driver Licence Holder Statistics" },
      },
      (rawInput) => getLicenceHolderStatsHandler(rawInput, this.env),
    );
  }
}
