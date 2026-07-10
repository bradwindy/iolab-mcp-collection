function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= (aBytes[i] as number) ^ (bBytes[i] as number);
  }
  return diff === 0;
}

/**
 * Validate the shared bearer token on the MCP protocol endpoint. This is the only
 * gate on `/mcp` — Cloudflare Access protects the human-facing portal separately,
 * since MCP clients (Claude Code, claude.ai connectors) connect server-to-server
 * and cannot complete an interactive Access login.
 *
 * Returns a Response to send immediately (401/500), or null to continue routing.
 */
export function requireBearerToken(request: Request, expectedToken: string | undefined): Response | null {
  if (!expectedToken) {
    return new Response("Server misconfigured: MCP_SHARED_TOKEN is not set.", { status: 500 });
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match?.[1];
  if (!provided || !timingSafeEqual(provided, expectedToken)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    });
  }
  return null;
}
