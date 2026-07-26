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
 * Checks whether `request` carries an `Authorization: Bearer <expectedToken>` header
 * matching `expectedToken` exactly (constant-time comparison). Used both by
 * {@link requireBearerToken} (servers without OAuth) and by the OAuth wrapper in
 * `oauth.ts`, which bypasses the OAuth provider entirely for requests presenting the
 * static shared token — see `buildMultiServerOAuthWorker`.
 */
export function bearerTokenMatches(request: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match?.[1];
  return provided !== undefined && timingSafeEqual(provided, expectedToken);
}

/**
 * Validate the shared bearer token on the MCP protocol endpoint. Servers that also
 * wire up OAuth (see `oauth.ts`) don't call this directly — they use
 * {@link bearerTokenMatches} as a bypass check in front of the OAuth provider so the
 * shared token keeps working for server-to-server clients (Claude Code) that can't
 * complete an interactive Access login.
 *
 * Returns a Response to send immediately (401/500), or null to continue routing.
 */
export function requireBearerToken(request: Request, expectedToken: string | undefined): Response | null {
  if (!expectedToken) {
    return new Response("Server misconfigured: MCP_SHARED_TOKEN is not set.", { status: 500 });
  }
  if (!bearerTokenMatches(request, expectedToken)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    });
  }
  return null;
}
