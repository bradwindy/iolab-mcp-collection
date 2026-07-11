import { buildOAuthMcpWorker } from "@nz-mcp/mcp-kit";
import { NzGovtMcp } from "./agent.js";

export { NzGovtMcp };

export default buildOAuthMcpWorker<Env>(NzGovtMcp, "NZ_GOVT_MCP");
