/**
 * Every tool in this collection is read-only and hits an external (non-sandboxed)
 * upstream API — set on every registered tool per MCP annotation guidance.
 */
export const READ_ONLY_OPEN_WORLD_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;
