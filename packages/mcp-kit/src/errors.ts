import type { ToolTextResult } from "./response.js";

/** Thrown by upstream API clients on a non-2xx response; tool handlers catch it and call upstreamError(). */
export class UpstreamHttpError extends Error {
  constructor(
    public readonly source: string,
    public readonly response: Response,
  ) {
    super(`${source} returned HTTP ${response.status} ${response.statusText}`);
    this.name = "UpstreamHttpError";
  }
}

/**
 * Build a tool-execution error (not a protocol error) per MCP guidance: the model
 * can see and self-correct from these. Always include a concrete next step.
 */
export function toolError(message: string, hint?: string): ToolTextResult {
  const text = hint ? `${message} ${hint}` : message;
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

/** Standard actionable error for an upstream HTTP failure. */
export function upstreamError(source: string, response: Response, hint?: string): ToolTextResult {
  return toolError(
    `${source} returned HTTP ${response.status} ${response.statusText}.`,
    hint ?? "This may be transient; retry, or narrow the request if the upstream is rate-limiting.",
  );
}

/** Standard actionable error when an upstream credential has not been configured yet. */
export function missingCredentialError(serverSlug: string, keyName: string, portalUrl: string): ToolTextResult {
  return toolError(
    `The upstream API key '${keyName}' is not configured for ${serverSlug}.`,
    `Set it at ${portalUrl}/admin/servers/${serverSlug}, then retry.`,
  );
}
