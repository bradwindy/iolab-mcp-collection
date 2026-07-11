import { buildOAuthMcpWorker } from "@nz-mcp/mcp-kit";
import { NzGeoMcp } from "./agent.js";

export { NzGeoMcp };

export default buildOAuthMcpWorker<Env>(NzGeoMcp, "NZ_GEO_MCP");
