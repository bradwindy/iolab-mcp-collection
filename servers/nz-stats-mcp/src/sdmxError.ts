import { toolError, upstreamError, type ToolTextResult, type UpstreamHttpError } from "@iolab/mcp-kit";
import { SUBSCRIPTION_KEY_NAME } from "./constants.js";

/**
 * Turn an UpstreamHttpError from the Stats NZ SDMX API into an actionable tool result.
 * 401/403 almost always means an invalid, expired, or unsubscribed key rather than a
 * transient failure, so give that specific fix instead of the generic retry hint.
 */
export function handleSdmxUpstreamError(error: UpstreamHttpError, env: Env): ToolTextResult {
  if (error.response.status === 401 || error.response.status === 403) {
    return toolError(
      `Stats NZ Aotearoa Data Explorer returned HTTP ${error.response.status} ${error.response.statusText}.`,
      `Check that the '${SUBSCRIPTION_KEY_NAME}' credential is a valid, active subscription key. ` +
        `Regenerate it at https://portal.apis.stats.govt.nz/ (Profile > Subscriptions) if needed, ` +
        `then update it at ${env.PORTAL_URL}/servers/nz-stats-mcp.`,
    );
  }
  return upstreamError(error.source, error.response);
}
