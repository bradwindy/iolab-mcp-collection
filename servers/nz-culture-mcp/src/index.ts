import { requireBearerToken } from "@nz-mcp/mcp-kit";
import { NzCultureMcp } from "./agent.js";

export { NzCultureMcp };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const unauthorized = requireBearerToken(request, env.MCP_SHARED_TOKEN);
    if (unauthorized) return unauthorized;

    return NzCultureMcp.serve("/mcp", { binding: "NZ_CULTURE_MCP" }).fetch(request, env, ctx);
  },
};
