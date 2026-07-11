import { buildOAuthMcpWorker } from "@nz-mcp/mcp-kit";
import { NzStatsMcp } from "./agent.js";

export { NzStatsMcp };

export default buildOAuthMcpWorker<Env>(NzStatsMcp, "NZ_STATS_MCP");
