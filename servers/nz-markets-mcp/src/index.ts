import { requireBearerToken } from "@nz-mcp/mcp-kit";
import { NzMarketsMcp } from "./agent.js";

export { NzMarketsMcp };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const unauthorized = requireBearerToken(request, env.MCP_SHARED_TOKEN);
    if (unauthorized) return unauthorized;

    return NzMarketsMcp.serve("/mcp", { binding: "NZ_MARKETS_MCP" }).fetch(request, env, ctx);
  },
};
