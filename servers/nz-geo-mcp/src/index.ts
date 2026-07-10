import { requireBearerToken } from "@nz-mcp/mcp-kit";
import { NzGeoMcp } from "./agent.js";

export { NzGeoMcp };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const unauthorized = requireBearerToken(request, env.MCP_SHARED_TOKEN);
    if (unauthorized) return unauthorized;

    return NzGeoMcp.serve("/mcp", { binding: "NZ_GEO_MCP" }).fetch(request, env, ctx);
  },
};
