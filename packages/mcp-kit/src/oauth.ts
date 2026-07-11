import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { bearerTokenMatches } from "./auth.js";

/**
 * Identity surfaced to MCP tool handlers for requests that authenticated via OAuth (Access-gated
 * `/authorize`). Extends `Record<string, unknown>` (rather than a plain `{ email: string }`) so it
 * satisfies `McpAgent`'s `Props` generic constraint directly — see each server's `agent.ts`.
 */
export interface OAuthProps extends Record<string, unknown> {
  email: string;
}

interface AccessJwtEnv {
  /** The operator's Cloudflare Zero Trust team domain, e.g. `myteam.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN: string;
  /** Audience (AUD) tag of the Access application scoped to this server's `/authorize` path. */
  ACCESS_AUD: string;
  /** The single operator email allowed to complete the OAuth login. */
  ACCESS_EMAIL: string;
}

/** Everything `buildOAuthMcpWorker` needs beyond what each server's `Env` already declares for the bearer path. */
export interface OAuthMcpEnv extends AccessJwtEnv {
  MCP_SHARED_TOKEN: string;
  // The OAuth provider library reads/writes this KV binding directly at runtime; this package
  // never calls its methods itself, so (matching CacheNamespace's minimal-structural-type
  // convention above) it isn't worth depending on @cloudflare/workers-types just to name it.
  OAUTH_KV: unknown;
  OAUTH_PROVIDER: OAuthHelpers;
}

// jose's JWKS fetcher isn't available until a request carries `env`, so the per-team-domain
// resolver is cached lazily here rather than at module load.
const jwksByTeamDomain = new Map<string, JWTVerifyGetKey>();

let jwksResolverOverride: ((teamDomain: string) => JWTVerifyGetKey) | undefined;

/**
 * Test-only seam: replace how `verifyAccessJwt` resolves a team domain's JWKS, so tests can
 * sign a token against a local keypair instead of fetching the real Access certs endpoint.
 * Call with `undefined` to restore the real remote-JWKS resolver.
 */
export function __setAccessJwksResolverForTesting(resolver: ((teamDomain: string) => JWTVerifyGetKey) | undefined) {
  jwksResolverOverride = resolver;
  jwksByTeamDomain.clear();
}

function getJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksByTeamDomain.get(teamDomain);
  if (!jwks) {
    jwks = jwksResolverOverride
      ? jwksResolverOverride(teamDomain)
      : createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeamDomain.set(teamDomain, jwks);
  }
  return jwks;
}

function extractAccessJwt(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") ?? "";
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match?.[1] ?? null;
}

/**
 * Verifies the Cloudflare Access identity on `request`: signature (via the team's JWKS),
 * `iss`/`aud`, and that the token's email matches the single allowed operator. Returns `null`
 * on any failure — never trust `Cf-Access-Authenticated-User-Email` alone, since only the JWT
 * signature proves Access actually issued it.
 */
export async function verifyAccessJwt(request: Request, env: AccessJwtEnv): Promise<{ email: string } | null> {
  const token = extractAccessJwt(request);
  if (!token) return null;

  try {
    const jwks = getJwks(env.ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });
    const email = typeof payload.email === "string" ? payload.email : null;
    if (!email || email !== env.ACCESS_EMAIL) return null;
    return { email };
  } catch {
    return null;
  }
}

type AuthorizeEnv = AccessJwtEnv & { OAUTH_PROVIDER: OAuthHelpers };

const CSRF_COOKIE_NAME = "__Host-OAUTH_CSRF";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function extractCsrfCookie(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = new RegExp(`(?:^|;\\s*)${CSRF_COOKIE_NAME}=([^;]+)`).exec(cookie);
  return match?.[1] ?? null;
}

/**
 * Renders a consent page for `GET /authorize`: the caller is already Access-authenticated (verified
 * by the handler below before this runs), but has not yet said *which* client they mean to authorize.
 * Without this step, a single crafted link (or even a plain top-level redirect) to `/authorize` from an
 * attacker-registered OAuth client — DCR is public, per the MCP spec — would silently grant that client
 * a token scoped to the operator's identity while an Access session happens to be live: a classic
 * confused-deputy / session-riding gap. Requiring an explicit POST closes it; the CSRF token (bound via
 * a `__Host-` cookie set on this response and echoed back as a hidden field on submit — the "double
 * submit cookie" pattern) additionally stops a forged cross-site POST from skipping the click entirely.
 */
async function renderAuthorizeConsent<Env extends AuthorizeEnv>(request: Request, env: Env): Promise<Response> {
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    return new Response(`Invalid authorization request: ${err instanceof Error ? err.message : "unknown error"}`, {
      status: 400,
    });
  }

  const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  const clientName = clientInfo?.clientName || oauthReqInfo.clientId;

  // Echo every original query param back verbatim as hidden fields (not just the ones the parsed
  // AuthRequest names) so a repeated param like `resource` round-trips exactly, and so the POST
  // handler can re-run parseAuthRequest on the reconstructed URL instead of re-deriving it by hand.
  // A crafted link could itself carry a `csrf_token` param, which would render a hidden field ahead
  // of the real one and shadow it on submit (formData.get() returns the first match) — fail closed
  // but an annoying self-DoS, so it's dropped here; the one appended below is the only one that counts.
  const hiddenInputs = [...new URL(request.url).searchParams.entries()]
    .filter(([name]) => name !== "csrf_token")
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join("\n      ");

  const csrfToken = crypto.randomUUID();
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Authorize</title>
  </head>
  <body>
    <h1>Authorize access</h1>
    <p><strong>${escapeHtml(clientName)}</strong> (client ID <code>${escapeHtml(oauthReqInfo.clientId)}</code>)
      wants to connect to this MCP server as <strong>${escapeHtml(env.ACCESS_EMAIL)}</strong>.</p>
    <p>It will be redirected to: <code>${escapeHtml(oauthReqInfo.redirectUri)}</code></p>
    <form method="POST" action="/authorize">
      ${hiddenInputs}
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
      <button type="submit">Approve</button>
    </form>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `${CSRF_COOKIE_NAME}=${csrfToken}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=300`,
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

/** Completes `POST /authorize` after the consent form is submitted: validates the CSRF token, then grants. */
async function completeAuthorizeConsent<Env extends AuthorizeEnv>(
  request: Request,
  env: Env,
  identity: { email: string },
): Promise<Response> {
  const formData = await request.formData();

  const cookieToken = extractCsrfCookie(request);
  const formToken = formData.get("csrf_token");
  if (!cookieToken || typeof formToken !== "string" || formToken !== cookieToken) {
    return new Response("Forbidden: missing or invalid CSRF token. Restart the authorization flow.", {
      status: 403,
    });
  }

  const reconstructedUrl = new URL("/authorize", request.url);
  for (const [name, value] of formData.entries()) {
    if (name === "csrf_token") continue;
    reconstructedUrl.searchParams.append(name, String(value));
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(reconstructedUrl));
  } catch (err) {
    return new Response(`Invalid authorization request: ${err instanceof Error ? err.message : "unknown error"}`, {
      status: 400,
    });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: identity.email,
    scope: oauthReqInfo.scope,
    metadata: { label: identity.email },
    props: { email: identity.email } satisfies OAuthProps,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
      "Set-Cookie": `${CSRF_COOKIE_NAME}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
    },
  });
}

/**
 * The OAuth provider's `defaultHandler`: serves `/authorize`, gated by an upstream Cloudflare Access
 * application scoped to that path. `GET` renders a consent page (see `renderAuthorizeConsent`); `POST`
 * (the page's own form submit) completes the grant. Access authentication is re-verified on both
 * methods — the JWT alone answers "who," never "did they mean to approve this specific client."
 */
export function createAccessAuthorizeHandler<Env extends AuthorizeEnv>(): {
  fetch(request: Request, env: Env): Promise<Response>;
} {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname !== "/authorize") {
        return new Response("Not found", { status: 404 });
      }

      const identity = await verifyAccessJwt(request, env);
      if (!identity) {
        return new Response("Forbidden: Cloudflare Access did not authenticate this request.", { status: 403 });
      }

      if (request.method === "GET") return renderAuthorizeConsent(request, env);
      if (request.method === "POST") return completeAuthorizeConsent(request, env, identity);
      return new Response("Method not allowed", { status: 405 });
    },
  };
}

interface McpAgentClass<Env> {
  serve(
    path: string,
    opts: { binding: string },
  ): {
    // `ctx` is deliberately `any`: it's the platform's real `ExecutionContext`, but naming that
    // type would pull in `@cloudflare/workers-types` (see the `OAUTH_KV` comment above); this
    // package only ever forwards it untouched between `agent.serve()`'s handler and the OAuth
    // provider's, both of which type it concretely once compiled inside a server package.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch(request: Request, env: Env, ctx: any): Promise<Response>;
  };
}

/**
 * Wraps an MCP server's `McpAgent` class with OAuth 2.1 + PKCE (via
 * `@cloudflare/workers-oauth-provider`) while preserving the existing static bearer token for
 * server-to-server clients (Claude Code) that can't complete an interactive login. Requests to
 * `/mcp` carrying the exact `MCP_SHARED_TOKEN` bypass the OAuth provider entirely; every other
 * request — including a token-less or wrong-token `/mcp` request — flows through the provider,
 * which returns the spec-correct `401 + WWW-Authenticate: Bearer resource_metadata=…` that
 * triggers claude.ai's OAuth handshake, and serves `/token`, `/register`, `/authorize`, and the
 * `.well-known` discovery documents.
 */
export function buildOAuthMcpWorker<Env extends OAuthMcpEnv>(
  agent: McpAgentClass<Env>,
  mcpBinding: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { fetch(request: Request, env: Env, ctx: any): Promise<Response> } {
  const mcpHandler = agent.serve("/mcp", { binding: mcpBinding });

  const provider = new OAuthProvider<Env>({
    apiHandlers: { "/mcp": mcpHandler },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // OAuth 2.1 drops plain PKCE; only accept/advertise S256.
    allowPlainPKCE: false,
    defaultHandler: createAccessAuthorizeHandler<Env>(),
  });

  return {
    fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === "/mcp" && bearerTokenMatches(request, env.MCP_SHARED_TOKEN)) {
        return mcpHandler.fetch(request, env, ctx);
      }
      return provider.fetch(request, env, ctx);
    },
  };
}
