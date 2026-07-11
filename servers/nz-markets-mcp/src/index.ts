import { buildOAuthMcpWorker } from "@nz-mcp/mcp-kit";
import { NzMarketsMcp } from "./agent.js";

export { NzMarketsMcp };

export default buildOAuthMcpWorker<Env>(NzMarketsMcp, "NZ_MARKETS_MCP");
