import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
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

/**
 * The OAuth provider's `defaultHandler`: serves `GET /authorize`, gated by an upstream
 * Cloudflare Access application scoped to that path. Access has already completed the
 * interactive login by the time this runs, so the Access JWT is auto-approved (no separate
 * consent UI) into an OAuth grant for the requesting MCP client.
 */
export function createAccessAuthorizeHandler<Env extends AccessJwtEnv & { OAUTH_PROVIDER: OAuthHelpers }>(): {
  fetch(request: Request, env: Env): Promise<Response>;
} {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname !== "/authorize") {
        return new Response("Not found", { status: 404 });
      }
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      const identity = await verifyAccessJwt(request, env);
      if (!identity) {
        return new Response("Forbidden: Cloudflare Access did not authenticate this request.", { status: 403 });
      }

      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: identity.email,
        scope: oauthReqInfo.scope,
        metadata: { label: identity.email },
        props: { email: identity.email } satisfies OAuthProps,
      });
      return Response.redirect(redirectTo, 302);
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
