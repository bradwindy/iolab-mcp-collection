import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS, type OAuthProps } from "@iolab/mcp-kit";
import { queryLdsLayerHandler, queryLdsLayerInputShape, queryLdsLayerOutputShape } from "./tools/queryLdsLayer.js";
import { getParcelHandler, getParcelInputShape, getParcelOutputShape } from "./tools/getParcel.js";
import {
  getBasemapStyleUrlHandler,
  getBasemapStyleUrlInputShape,
  getBasemapStyleUrlOutputShape,
} from "./tools/getBasemapStyleUrl.js";
import {
  searchCanterburyServicesHandler,
  searchCanterburyServicesInputShape,
  searchCanterburyServicesOutputShape,
} from "./tools/searchCanterburyServices.js";
import {
  queryCanterburyLayerHandler,
  queryCanterburyLayerInputShape,
  queryCanterburyLayerOutputShape,
} from "./tools/queryCanterburyLayer.js";
import {
  searchCanterburyAddressesHandler,
  searchCanterburyAddressesInputShape,
  searchCanterburyAddressesOutputShape,
} from "./tools/searchCanterburyAddresses.js";

export class NzGeoMcp extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({ name: "nz-geo-mcp", version: "0.1.0" });

  async init() {
    // --- LINZ Data Service (needs LINZ_API_KEY) ---------------------------------------------

    this.server.registerTool(
      "nz_geo_query_layer",
      {
        description:
          "Escape hatch: run a point+radius spatial query against one or more LINZ Data Service vector " +
          "layers (e.g. parcels, addresses, topographic features) and return attributes near a coordinate. " +
          "Requires a LINZ Data Service API key. Prefer nz_geo_get_parcel for the common 'what parcel is here' case.",
        inputSchema: queryLdsLayerInputShape,
        outputSchema: queryLdsLayerOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Query LINZ Data Service Layer" },
      },
      (rawInput: unknown) => queryLdsLayerHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_geo_get_parcel",
      {
        description:
          "Find NZ land parcel(s) (legal description, parcel intent, land district, area, title count) at or " +
          "near a coordinate, using LINZ's NZ Primary Parcels layer. Requires a LINZ Data Service API key.",
        inputSchema: getParcelInputShape,
        outputSchema: getParcelOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Parcel At Location" },
      },
      (rawInput: unknown) => getParcelHandler(rawInput, this.env),
    );

    // --- LINZ Basemaps (needs LINZ_BASEMAPS_API_KEY) ----------------------------------------

    this.server.registerTool(
      "nz_geo_get_basemap_style_url",
      {
        description:
          "Build a ready-to-use LINZ Basemaps tile/style/WMTS URL (with your API key injected) for aerial " +
          "imagery or the topographic map — for use in a mapping client, not for fetching tile bytes through MCP. " +
          "Requires a LINZ Basemaps API key.",
        inputSchema: getBasemapStyleUrlInputShape,
        outputSchema: getBasemapStyleUrlOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Basemap Style/Tile URL" },
      },
      (rawInput: unknown) => getBasemapStyleUrlHandler(rawInput, this.env),
    );

    // --- Canterbury Maps public ArcGIS server (no key required) -----------------------------

    this.server.registerTool(
      "nz_geo_search_canterbury_services",
      {
        description:
          "Search the Canterbury Maps public ArcGIS service directory (Environment Canterbury) by keyword to " +
          "find a MapServer/FeatureServer/GeocodeServer covering a topic, e.g. 'groundwater' or 'flood'. No API key needed.",
        inputSchema: searchCanterburyServicesInputShape,
        outputSchema: searchCanterburyServicesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Canterbury Maps Services" },
      },
      (rawInput: unknown) => searchCanterburyServicesHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_geo_query_canterbury_layer",
      {
        description:
          "Escape hatch: list sub-layers of a Canterbury Maps service (omit layer_id), or query features from " +
          "one sub-layer with a SQL WHERE clause. Use nz_geo_search_canterbury_services first to find a service_path. " +
          "No API key needed.",
        inputSchema: queryCanterburyLayerInputShape,
        outputSchema: queryCanterburyLayerOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Query Canterbury Maps Layer" },
      },
      queryCanterburyLayerHandler,
    );

    this.server.registerTool(
      "nz_geo_search_canterbury_addresses",
      {
        description:
          "Geocode a street address or named place (park, suburb, landmark) within Canterbury to coordinates, " +
          "using Environment Canterbury's public locators. No API key needed. Canterbury region only.",
        inputSchema: searchCanterburyAddressesInputShape,
        outputSchema: searchCanterburyAddressesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Canterbury Addresses & Places" },
      },
      searchCanterburyAddressesHandler,
    );
  }
}
