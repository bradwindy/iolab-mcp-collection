import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { READ_ONLY_OPEN_WORLD_ANNOTATIONS, type OAuthProps } from "@iolab/mcp-kit";
import {
  getMortgageRatesHandler,
  getMortgageRatesInputShape,
  getMortgageRatesOutputShape,
} from "./tools/getMortgageRates.js";
import {
  getConsumerLoanRatesHandler,
  getConsumerLoanRatesInputShape,
  getConsumerLoanRatesOutputShape,
} from "./tools/getConsumerLoanRates.js";
import { searchCompaniesHandler, searchCompaniesInputShape, searchCompaniesOutputShape } from "./tools/searchCompanies.js";
import { getCompanyHandler, getCompanyInputShape, getCompanyOutputShape } from "./tools/getCompany.js";
import {
  searchMarketAnnouncementsHandler,
  searchMarketAnnouncementsInputShape,
  searchMarketAnnouncementsOutputShape,
} from "./tools/searchMarketAnnouncements.js";
import {
  getElectricityDispatchHandler,
  getElectricityDispatchInputShape,
  getElectricityDispatchOutputShape,
} from "./tools/getElectricityDispatch.js";
import {
  searchIcpConnectionsHandler,
  searchIcpConnectionsInputShape,
  searchIcpConnectionsOutputShape,
} from "./tools/searchIcpConnections.js";

export class NzMarketsMcp extends McpAgent<Env, Record<string, never>, OAuthProps> {
  server = new McpServer({ name: "nz-markets-mcp", version: "0.1.0" });

  async init() {
    this.server.registerTool(
      "nz_markets_get_mortgage_rates",
      {
        description:
          "List current NZ mortgage rates by institution and term, sourced hourly from interest.co.nz via the " +
          "Rates API. No API key required.",
        inputSchema: getMortgageRatesInputShape,
        outputSchema: getMortgageRatesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Mortgage Rates" },
      },
      getMortgageRatesHandler,
    );

    this.server.registerTool(
      "nz_markets_get_consumer_loan_rates",
      {
        description:
          "List current NZ personal loan, car loan, or credit card rates by institution, sourced hourly from " +
          "interest.co.nz via the Rates API. No API key required.",
        inputSchema: getConsumerLoanRatesInputShape,
        outputSchema: getConsumerLoanRatesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Consumer Loan Rates" },
      },
      getConsumerLoanRatesHandler,
    );

    this.server.registerTool(
      "nz_markets_search_companies",
      {
        description:
          "Search or browse NZX-listed companies by name, ticker, or sector. Requires an NZXplorer API key " +
          "configured via the portal.",
        inputSchema: searchCompaniesInputShape,
        outputSchema: searchCompaniesOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search NZX Companies" },
      },
      (rawInput) => searchCompaniesHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_markets_get_company",
      {
        description:
          "Fetch a single NZX-listed company's profile (sector, market cap, identifiers) by ticker symbol. " +
          "Requires an NZXplorer API key configured via the portal.",
        inputSchema: getCompanyInputShape,
        outputSchema: getCompanyOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get NZX Company" },
      },
      (rawInput) => getCompanyHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_markets_search_market_announcements",
      {
        description:
          "Full-text search NZX market announcements and disclosures (2017-present) by keyword, ticker, " +
          "announcement type, and/or date range. Requires an NZXplorer API key configured via the portal.",
        inputSchema: searchMarketAnnouncementsInputShape,
        outputSchema: searchMarketAnnouncementsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search Market Announcements" },
      },
      (rawInput) => searchMarketAnnouncementsHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_markets_get_electricity_dispatch",
      {
        description:
          "Get near-real-time (5-minute interval) electricity dispatch prices, generation, and demand by grid " +
          "point of connection, from the Electricity Authority's EMI real-time dispatch API. Requires an EA " +
          "'Wholesale market prices' subscription key configured via the portal.",
        inputSchema: getElectricityDispatchInputShape,
        outputSchema: getElectricityDispatchOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Get Electricity Dispatch" },
      },
      (rawInput) => getElectricityDispatchHandler(rawInput, this.env),
    );

    this.server.registerTool(
      "nz_markets_search_icp_connections",
      {
        description:
          "Look up NZ electricity connection (ICP) data by exact ICP identifier or by street address, from the " +
          "Electricity Authority's EMI ICP connection data API. Requires an EA 'ICP connection data' " +
          "subscription key configured via the portal.",
        inputSchema: searchIcpConnectionsInputShape,
        outputSchema: searchIcpConnectionsOutputShape,
        annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "Search ICP Connections" },
      },
      (rawInput) => searchIcpConnectionsHandler(rawInput, this.env),
    );
  }
}
