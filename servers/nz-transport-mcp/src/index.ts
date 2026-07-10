import { requireBearerToken } from "@nz-mcp/mcp-kit";
import { NzTransportMcp } from "./agent.js";

export { NzTransportMcp };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const unauthorized = requireBearerToken(request, env.MCP_SHARED_TOKEN);
    if (unauthorized) return unauthorized;

    return NzTransportMcp.serve("/mcp", { binding: "NZ_TRANSPORT_MCP" }).fetch(request, env, ctx);
  },
};
