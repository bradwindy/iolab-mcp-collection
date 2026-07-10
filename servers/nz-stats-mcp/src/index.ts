import { requireBearerToken } from "@nz-mcp/mcp-kit";
import { NzStatsMcp } from "./agent.js";

export { NzStatsMcp };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const unauthorized = requireBearerToken(request, env.MCP_SHARED_TOKEN);
    if (unauthorized) return unauthorized;

    return NzStatsMcp.serve("/mcp", { binding: "NZ_STATS_MCP" }).fetch(request, env, ctx);
  },
};
