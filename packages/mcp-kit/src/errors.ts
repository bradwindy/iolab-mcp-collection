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
 *
 * Every tool error that reaches this point is logged server-side (console.error) — previously
 * nothing was, so a failing tool left zero trace in Workers Logs beyond whatever the caller saw
 * in the JSON-RPC response; a caller reporting "it errored" was otherwise undiagnosable after
 * the fact.
 */
export function toolError(message: string, hint?: string): ToolTextResult {
  const text = hint ? `${message} ${hint}` : message;
  console.error(`[tool-error] ${text}`);
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

/**
 * The agent-facing hint for an HTTP 429. Deliberately says "wait", not "retry": some upstreams
 * (the Wayback Machine, per Internet Archive staff) escalate to an hour-long IP block when 429s
 * keep being ignored, so the generic "retry" advice actively makes a 429 worse.
 */
export function rateLimitHint(response: Response): string {
  const seconds = Number(response.headers.get("retry-after"));
  const wait = Number.isFinite(seconds) && seconds > 0 ? `about ${Math.ceil(seconds)} seconds` : "a few minutes";
  return `The upstream is rate-limiting this server. Wait ${wait} before calling it again; retrying straight away can extend the block.`;
}

/** Standard actionable error for an upstream HTTP failure. */
export function upstreamError(source: string, response: Response, hint?: string): ToolTextResult {
  console.error(
    `[upstream-error] ${source} returned HTTP ${response.status} ${response.statusText}`,
    `url=${response.url}`,
    // Logged so a 429 is diagnosable after the fact: a short throttle and an hours-long block
    // look identical to the caller, and only these headers tell them apart.
    `retry-after=${response.headers.get("retry-after") ?? "none"}`,
  );
  const defaultHint =
    response.status === 429
      ? rateLimitHint(response)
      : "This may be transient; retry, or narrow the request if the upstream is rate-limiting.";
  return toolError(`${source} returned HTTP ${response.status} ${response.statusText}.`, hint ?? defaultHint);
}

/** Standard actionable error when an upstream credential has not been configured yet. */
export function missingCredentialError(serverSlug: string, keyName: string, portalUrl: string): ToolTextResult {
  return toolError(
    `The upstream API key '${keyName}' is not configured for ${serverSlug}.`,
    `Set it at ${portalUrl}/admin/servers/${serverSlug}, then retry.`,
  );
}
