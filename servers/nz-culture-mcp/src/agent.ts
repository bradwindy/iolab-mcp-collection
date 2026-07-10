import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS } from "@nz-mcp/mcp-kit";
import {
  searchDigitalnzHandler,
  searchDigitalnzInputShape,
  searchDigitalnzOutputShape,
} from "./tools/searchDigitalnz.js";
import {
  getDigitalnzRecordHandler,
  getDigitalnzRecordInputShape,
  getDigitalnzRecordOutputShape,
} from "./tools/getDigitalnzRecord.js";
import { searchTePapaHandler, searchTePapaInputShape, searchTePapaOutputShape } from "./tools/searchTePapa.js";
import { getTePapaItemHandler, getTePapaItemInputShape, getTePapaItemOutputShape } from "./tools/getTePapaItem.js";

export class NzCultureMcp extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer({ name: "nz-culture-mcp", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "nz_culture_search_digitalnz",
      {
        description:
          "Free-text search across DigitalNZ's 30M+ metadata records aggregated from NZ libraries, museums, " +
          "archives, and universities. No API key required.",
        inputSchema: searchDigitalnzInputShape,
        outputSchema: searchDigitalnzOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search DigitalNZ" },
      },
      searchDigitalnzHandler,
    );

    this.server.registerTool(
      "nz_culture_get_digitalnz_record",
      {
        description: "Fetch full metadata for a single DigitalNZ record by its numeric id. No API key required.",
        inputSchema: getDigitalnzRecordInputShape,
        outputSchema: getDigitalnzRecordOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get DigitalNZ Record" },
      },
      (rawInput) => getDigitalnzRecordHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_culture_search_te_papa",
      {
        description:
          "Search the Museum of New Zealand Te Papa Tongarewa's collections (objects, specimens, people, " +
          "places, taxa, publications) by keyword. Requires a Te Papa API key configured via the portal.",
        inputSchema: searchTePapaInputShape,
        outputSchema: searchTePapaOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Te Papa Collections" },
      },
      (rawInput) => searchTePapaHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_culture_get_te_papa_item",
      {
        description:
          "Fetch full metadata for a single Te Papa collection item by resource type and id. Requires a Te Papa " +
          "API key configured via the portal.",
        inputSchema: getTePapaItemInputShape,
        outputSchema: getTePapaItemOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Te Papa Item" },
      },
      (rawInput) => getTePapaItemHandler(rawInput, this.env),
    );
  }
}
