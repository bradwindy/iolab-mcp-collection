import { requireBearerToken } from "@nz-mcp/mcp-kit";
import { NzEnvironmentMcp } from "./agent.js";

export { NzEnvironmentMcp };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const unauthorized = requireBearerToken(request, env.MCP_SHARED_TOKEN);
    if (unauthorized) return unauthorized;

    return NzEnvironmentMcp.serve("/mcp", { binding: "NZ_ENVIRONMENT_MCP" }).fetch(request, env, ctx);
  },
};
