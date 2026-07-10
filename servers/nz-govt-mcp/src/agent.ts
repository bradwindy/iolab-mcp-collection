import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS } from "@nz-mcp/mcp-kit";
import {
  searchCharitiesHandler,
  searchCharitiesInputShape,
  searchCharitiesOutputShape,
} from "./tools/searchCharities.js";
import { searchDatasetsHandler, searchDatasetsInputShape, searchDatasetsOutputShape } from "./tools/searchDatasets.js";
import { getDatasetHandler, getDatasetInputShape, getDatasetOutputShape } from "./tools/getDataset.js";
import {
  searchAucklandOpenDataHandler,
  searchAucklandOpenDataInputShape,
  searchAucklandOpenDataOutputShape,
} from "./tools/searchAucklandOpenData.js";
import { searchSchoolsHandler, searchSchoolsInputShape, searchSchoolsOutputShape } from "./tools/searchSchools.js";
import {
  searchEarlyChildhoodServicesHandler,
  searchEarlyChildhoodServicesInputShape,
  searchEarlyChildhoodServicesOutputShape,
} from "./tools/searchEarlyChildhoodServices.js";
import {
  queryOpenDataSqlHandler,
  queryOpenDataSqlInputShape,
  queryOpenDataSqlOutputShape,
} from "./tools/queryOpenDataSql.js";

export class NzGovtMcp extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer({ name: "nz-govt-mcp", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "nz_govt_search_charities",
      {
        description:
          "Search NZ's Charities Register by name or exact registration number, optionally filtered by status.",
        inputSchema: searchCharitiesInputShape,
        outputSchema: searchCharitiesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Charities Register" },
      },
      searchCharitiesHandler,
    );

    this.server.registerTool(
      "nz_govt_search_datasets",
      {
        description: "Search the NZ government open data catalogue (data.govt.nz) for datasets by keyword.",
        inputSchema: searchDatasetsInputShape,
        outputSchema: searchDatasetsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Open Data Catalogue" },
      },
      searchDatasetsHandler,
    );

    this.server.registerTool(
      "nz_govt_get_dataset",
      {
        description: "Fetch full metadata and the resource list for one data.govt.nz dataset by id or slug.",
        inputSchema: getDatasetInputShape,
        outputSchema: getDatasetOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Dataset" },
      },
      getDatasetHandler,
    );

    this.server.registerTool(
      "nz_govt_search_auckland_open_data",
      {
        description: "Search Auckland Council's open data catalogue (GIS layers, tables, and services) by keyword.",
        inputSchema: searchAucklandOpenDataInputShape,
        outputSchema: searchAucklandOpenDataOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Auckland Open Data" },
      },
      searchAucklandOpenDataHandler,
    );

    this.server.registerTool(
      "nz_govt_search_schools",
      {
        description: "Search the Ministry of Education's directory of NZ schools by name and/or region.",
        inputSchema: searchSchoolsInputShape,
        outputSchema: searchSchoolsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Schools" },
      },
      searchSchoolsHandler,
    );

    this.server.registerTool(
      "nz_govt_search_early_childhood_services",
      {
        description:
          "Search the Ministry of Education's directory of NZ early childhood (ECE) services by name and/or region.",
        inputSchema: searchEarlyChildhoodServicesInputShape,
        outputSchema: searchEarlyChildhoodServicesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Early Childhood Services" },
      },
      searchEarlyChildhoodServicesHandler,
    );

    this.server.registerTool(
      "nz_govt_query_open_data_sql",
      {
        description:
          "Advanced escape hatch: run a read-only SQL SELECT against a datastore-enabled data.govt.nz resource. " +
          "Prefer the dedicated search tools first; use this for queries they don't support.",
        inputSchema: queryOpenDataSqlInputShape,
        outputSchema: queryOpenDataSqlOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Raw Open Data SQL Query" },
      },
      queryOpenDataSqlHandler,
    );
  }
}
