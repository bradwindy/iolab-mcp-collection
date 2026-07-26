import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS, type OAuthProps } from "@iolab/mcp-kit";
import { searchQuakesHandler, searchQuakesInputShape, searchQuakesOutputShape } from "./tools/searchQuakes.js";
import {
  getQuakeRevisionHistoryHandler,
  getQuakeRevisionHistoryInputShape,
  getQuakeRevisionHistoryOutputShape,
} from "./tools/getQuakeRevisionHistory.js";
import {
  getVolcanoAlertLevelsHandler,
  getVolcanoAlertLevelsInputShape,
  getVolcanoAlertLevelsOutputShape,
} from "./tools/getVolcanoAlertLevels.js";
import {
  getShakingIntensityHandler,
  getShakingIntensityInputShape,
  getShakingIntensityOutputShape,
} from "./tools/getShakingIntensity.js";
import {
  searchQuakeHistoryHandler,
  searchQuakeHistoryInputShape,
  searchQuakeHistoryOutputShape,
} from "./tools/searchQuakeHistory.js";
import {
  searchSeismicStationsHandler,
  searchSeismicStationsInputShape,
  searchSeismicStationsOutputShape,
} from "./tools/searchSeismicStations.js";
import {
  getWaveformDownloadUrlHandler,
  getWaveformDownloadUrlInputShape,
  getWaveformDownloadUrlOutputShape,
} from "./tools/getWaveformDownloadUrl.js";
import { getTideForecastHandler, getTideForecastInputShape, getTideForecastOutputShape } from "./tools/getTideForecast.js";
import { getUvForecastHandler, getUvForecastInputShape, getUvForecastOutputShape } from "./tools/getUvForecast.js";
import { getCo2LatestHandler, getCo2LatestInputShape, getCo2LatestOutputShape } from "./tools/getCo2Latest.js";

export class NzEnvironmentMcp extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({ name: "nz-environment-mcp", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "nz_env_search_quakes",
      {
        description:
          "Search GeoNet's near-real-time feed of recent NZ earthquakes (up to the 100 most recent within the last " +
          "365 days) by minimum shaking intensity (MMI), magnitude, and data-quality flag. For arbitrary historical " +
          "date ranges use nz_env_search_quake_history instead.",
        inputSchema: searchQuakesInputShape,
        outputSchema: searchQuakesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Recent Earthquakes" },
      },
      (rawInput) => searchQuakesHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_env_get_quake_revision_history",
      {
        description:
          "Get the location/magnitude revision history for a single earthquake by its GeoNet public ID — useful for " +
          "checking whether a preliminary/automatic estimate was later revised.",
        inputSchema: getQuakeRevisionHistoryInputShape,
        outputSchema: getQuakeRevisionHistoryOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Earthquake Revision History" },
      },
      (rawInput) => getQuakeRevisionHistoryHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_env_get_volcano_alert_levels",
      {
        description: "Get GeoNet's current Volcanic Alert Level and aviation colour code for NZ's monitored volcanoes.",
        inputSchema: getVolcanoAlertLevelsInputShape,
        outputSchema: getVolcanoAlertLevelsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Volcano Alert Levels" },
      },
      (rawInput) => getVolcanoAlertLevelsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_env_get_shaking_intensity",
      {
        description:
          "Get GeoNet shaking intensity: 'measured' instrument readings (last 60 minutes network-wide) or 'reported' " +
          "public felt-intensity reports (network-wide, or scoped to one quake's public ID).",
        inputSchema: getShakingIntensityInputShape,
        outputSchema: getShakingIntensityOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Shaking Intensity" },
      },
      (rawInput) => getShakingIntensityHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_env_search_quake_history",
      {
        description:
          "Search GeoNet's FDSN earthquake archive for any historical date range, filtered by magnitude, depth, " +
          "bounding box, and event type. The near-real-time index covers the last ~8 days; the archive lags live " +
          "events by ~7 days; a single query is capped at 10,000 events.",
        inputSchema: searchQuakeHistoryInputShape,
        outputSchema: searchQuakeHistoryOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Earthquake History (FDSN)" },
      },
      (rawInput) => searchQuakeHistoryHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_env_search_seismic_stations",
      {
        description: "Search GeoNet's FDSN seismic station network by network code, station code, and/or bounding box.",
        inputSchema: searchSeismicStationsInputShape,
        outputSchema: searchSeismicStationsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Seismic Stations (FDSN)" },
      },
      (rawInput) => searchSeismicStationsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_env_get_waveform_download_url",
      {
        description:
          "Advanced escape hatch: build a direct download URL for raw miniSEED waveform data from GeoNet's FDSN " +
          "dataselect service, for a given station/channel/time window. Does not fetch or inline the (binary, " +
          "potentially large) waveform itself.",
        inputSchema: getWaveformDownloadUrlInputShape,
        outputSchema: getWaveformDownloadUrlOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Waveform Download URL" },
      },
      getWaveformDownloadUrlHandler,
    );

    this.server.registerTool(
      "nz_env_get_tide_forecast",
      {
        description:
          "Get NIWA tide predictions (height in metres over time) for a NZ coastal/ocean location. Requires a NIWA " +
          "API key to be configured for this server.",
        inputSchema: getTideForecastInputShape,
        outputSchema: getTideForecastOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Tide Forecast" },
      },
      (rawInput) => getTideForecastHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_env_get_uv_forecast",
      {
        description:
          "Get NIWA's UV Index forecast time series for a NZ location. Requires a NIWA API key to be configured " +
          "for this server.",
        inputSchema: getUvForecastInputShape,
        outputSchema: getUvForecastOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get UV Forecast" },
      },
      (rawInput) => getUvForecastHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_env_get_co2_latest",
      {
        description:
          "Get the latest atmospheric CO2 reading from NIWA's Baring Head clean-air station near Wellington. " +
          "Requires a NIWA API key to be configured for this server.",
        inputSchema: getCo2LatestInputShape,
        outputSchema: getCo2LatestOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Latest CO2 Reading" },
      },
      (rawInput) => getCo2LatestHandler(rawInput, this.env),
    );
  }
}
