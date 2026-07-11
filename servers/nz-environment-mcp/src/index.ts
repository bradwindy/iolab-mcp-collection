import { buildOAuthMcpWorker } from "@nz-mcp/mcp-kit";
import { NzEnvironmentMcp } from "./agent.js";

export { NzEnvironmentMcp };

export default buildOAuthMcpWorker<Env>(NzEnvironmentMcp, "NZ_ENVIRONMENT_MCP");
