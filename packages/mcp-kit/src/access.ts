import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

// Deliberately its own module, separate from oauth.ts: that file imports
// `@cloudflare/workers-oauth-provider`, whose dist bundle does a bare `import ... from
// "cloudflare:workers"` at module scope. That resolves fine inside a real Worker (or
// `@cloudflare/vitest-pool-workers`), but breaks any consumer running under plain Node — like the
// portal's Hono app tests, which exercise the /admin/* access guard directly via `app.request()`
// with no Workers runtime at all. `@iolab/mcp-kit`'s main barrel still re-exports oauth.ts (so
// gateway/server code gets everything from one import), but that pulls in `cloudflare:workers`
// transitively — so a plain-Node consumer must import this file via the dedicated
// `@iolab/mcp-kit/access` subpath (see package.json `exports`) instead of the main barrel.

export interface AccessJwtEnv {
  /** The operator's Cloudflare Zero Trust team domain, e.g. `myteam.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN: string;
  /** Audience (AUD) tag of the single Access application scoped to `/authorize`. */
  ACCESS_AUD: string;
  /** The single operator email allowed to complete the OAuth login. */
  ACCESS_EMAIL: string;
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
 *
 * Logs the specific failure reason (never the token or a mismatched email itself) so a rejected
 * request is diagnosable from Workers Logs — "no token present" (Access misconfigured to not
 * reach this path, or session expired), a `jose` verification error (expired/bad signature/wrong
 * audience), and "email mismatch" are otherwise indistinguishable from the outside.
 */
export async function verifyAccessJwt(request: Request, env: AccessJwtEnv): Promise<{ email: string } | null> {
  const token = extractAccessJwt(request);
  if (!token) {
    console.warn("[access-jwt] no Cf-Access-Jwt-Assertion header or CF_Authorization cookie on request.");
    return null;
  }

  try {
    const jwks = getJwks(env.ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"],
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });
    const email = typeof payload.email === "string" ? payload.email : null;
    if (!email) {
      console.warn("[access-jwt] token verified but has no email claim.");
      return null;
    }
    if (email !== env.ACCESS_EMAIL) {
      console.warn("[access-jwt] token verified but its email does not match ACCESS_EMAIL.");
      return null;
    }
    return { email };
  } catch (err) {
    console.warn("[access-jwt] verification threw:", err instanceof Error ? `${err.name}: ${err.message}` : err);
    return null;
  }
}
