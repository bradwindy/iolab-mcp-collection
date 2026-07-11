import { buildOAuthMcpWorker } from "@nz-mcp/mcp-kit";
import { NzTransportMcp } from "./agent.js";

export { NzTransportMcp };

export default buildOAuthMcpWorker<Env>(NzTransportMcp, "NZ_TRANSPORT_MCP");
