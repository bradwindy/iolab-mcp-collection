import { requireBearerToken } from "@nz-mcp/mcp-kit";
import { NzGovtMcp } from "./agent.js";

export { NzGovtMcp };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const unauthorized = requireBearerToken(request, env.MCP_SHARED_TOKEN);
    if (unauthorized) return unauthorized;

    return NzGovtMcp.serve("/mcp", { binding: "NZ_GOVT_MCP" }).fetch(request, env, ctx);
  },
};
