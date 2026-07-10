export type ResponseFormat = "concise" | "detailed";

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Pick the concise or detailed variant of a value; concise is the default. */
export function selectFormat<C, D>(
  format: ResponseFormat | undefined,
  concise: C,
  detailed: D,
): C | D {
  return format === "detailed" ? detailed : concise;
}

/**
 * Wrap a plain object as an MCP tool result: human-readable JSON text plus
 * structuredContent for clients/code-execution harnesses that parse programmatically.
 * `data` should already match the tool's declared outputSchema shape.
 */
export function jsonResult(data: Record<string, unknown>): ToolTextResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** A one-line note to append when a result set was truncated, per best-practice guidance. */
export function truncationNotice(shown: number, total: number, hint: string): string {
  if (shown >= total) return "";
  return `Showing ${shown} of ${total}. ${hint}`;
}
