import { buildOAuthMcpWorker } from "@nz-mcp/mcp-kit";
import { NzCultureMcp } from "./agent.js";

export { NzCultureMcp };

export default buildOAuthMcpWorker<Env>(NzCultureMcp, "NZ_CULTURE_MCP");
