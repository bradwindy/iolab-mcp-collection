import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS } from "@nz-mcp/mcp-kit";
import {
  searchDataflowsHandler,
  searchDataflowsInputShape,
  searchDataflowsOutputShape,
} from "./tools/searchDataflows.js";
import {
  getPopulationByAreaHandler,
  getPopulationByAreaInputShape,
  getPopulationByAreaOutputShape,
} from "./tools/getPopulationByArea.js";
import {
  getBusinessDemographyHandler,
  getBusinessDemographyInputShape,
  getBusinessDemographyOutputShape,
} from "./tools/getBusinessDemography.js";
import {
  queryDataflowHandler,
  queryDataflowInputShape,
  queryDataflowOutputShape,
} from "./tools/queryDataflow.js";

export class NzStatsMcp extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer({ name: "nz-stats-mcp", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "nz_stats_search_dataflows",
      {
        description:
          "Search Stats NZ's Aotearoa Data Explorer SDMX dataflow catalogue (900+ tables) by keyword. " +
          "Use this to find a dataflow_id to pass to nz_stats_query_dataflow.",
        inputSchema: searchDataflowsInputShape,
        outputSchema: searchDataflowsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Stats NZ Dataflows" },
      },
      (rawInput) => searchDataflowsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_stats_get_population_by_area",
      {
        description:
          "Get subnational population estimates by area (Regional Council or SA2) and year, from Stats " +
          "NZ's Aotearoa Data Explorer. Returns total population (all ages, both sexes) per area/year.",
        inputSchema: getPopulationByAreaInputShape,
        outputSchema: getPopulationByAreaOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Population Estimates by Area" },
      },
      (rawInput) => getPopulationByAreaHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_stats_get_business_demography",
      {
        description:
          "Get business demography statistics (enterprise counts by industry and year) from Stats NZ's " +
          "Aotearoa Data Explorer.",
        inputSchema: getBusinessDemographyInputShape,
        outputSchema: getBusinessDemographyOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Business Demography" },
      },
      (rawInput) => getBusinessDemographyHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_stats_query_dataflow",
      {
        description:
          "Advanced escape hatch: run a raw SDMX query against any Stats NZ Aotearoa Data Explorer " +
          "dataflow. Prefer nz_stats_get_population_by_area / nz_stats_get_business_demography for those " +
          "topics; use this for anything else, after finding a dataflow_id with nz_stats_search_dataflows.",
        inputSchema: queryDataflowInputShape,
        outputSchema: queryDataflowOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Query Raw Stats NZ Dataflow" },
      },
      (rawInput) => queryDataflowHandler(rawInput, this.env),
    );
  }
}
