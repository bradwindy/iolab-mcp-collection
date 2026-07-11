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

/** Short id for correlating a GET's log line with its POST's, and for a user to quote back when reporting a problem. */
function generateFlowRef(): string {
  return crypto.randomUUID().slice(0, 8);
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
  const ref = generateFlowRef();

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    console.error(`[authorize:${ref}] GET: parseAuthRequest failed:`, err instanceof Error ? err.message : err);
    return new Response(
      `Invalid authorization request: ${err instanceof Error ? err.message : "unknown error"} (ref: ${ref})`,
      { status: 400 },
    );
  }

  const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  const clientName = clientInfo?.clientName || oauthReqInfo.clientId;

  console.log(
    `[authorize:${ref}] GET: rendering consent page.`,
    `client_id=${oauthReqInfo.clientId}`,
    `redirect_uri=${oauthReqInfo.redirectUri}`,
  );

  // Echo every original query param back verbatim as hidden fields (not just the ones the parsed
  // AuthRequest names) so a repeated param like `resource` round-trips exactly, and so the POST
  // handler can re-run parseAuthRequest on the reconstructed URL instead of re-deriving it by hand.
  // A crafted link could itself carry a `csrf_token`/`flow_ref` param, which would render a hidden
  // field ahead of the real one and shadow it on submit (formData.get() returns the first match) —
  // fail closed but an annoying self-DoS, so both are dropped here; the ones appended below (the
  // only ones that count) always come last in the form.
  const hiddenInputs = [...new URL(request.url).searchParams.entries()]
    .filter(([name]) => name !== "csrf_token" && name !== "flow_ref")
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join("\n      ");

  const csrfToken = crypto.randomUUID();
  const nonce = crypto.randomUUID();
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
    <form method="POST" action="/authorize" id="authorize-form" data-ref="${escapeHtml(ref)}">
      ${hiddenInputs}
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
      <input type="hidden" name="flow_ref" value="${escapeHtml(ref)}" />
      <button type="submit" id="approve-button">Approve</button>
      <span id="approve-status" role="status"></span>
    </form>
    <p><small>Reference: <code>${escapeHtml(ref)}</code></small></p>
    <script nonce="${nonce}">
      (function () {
        var form = document.getElementById("authorize-form");
        var button = document.getElementById("approve-button");
        var status = document.getElementById("approve-status");
        var ref = form.getAttribute("data-ref");
        console.log("[oauth-consent] page loaded", { ref: ref, time: new Date().toISOString() });
        form.addEventListener("submit", function () {
          console.log("[oauth-consent] approve clicked, submitting form", { ref: ref, time: new Date().toISOString() });
          button.disabled = true;
          status.textContent = " Submitting…";
        });
      })();
    </script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // 10 minutes, not 5: real-world consent clicks can be slower than a synthetic test — a user
      // reading the client name/redirect URI, switching tabs, or just being interrupted mid-click
      // is normal, and a token that expired mid-read reads to them as "the button does nothing."
      "Set-Cookie": `${CSRF_COOKIE_NAME}=${csrfToken}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
      "X-Frame-Options": "DENY",
      // 'script-src nonce-...' (not 'none'): the inline script below only logs client-side
      // diagnostics and shows submit feedback — nothing it does touches untrusted data (clientName/
      // clientId/redirectUri are rendered as escaped text elsewhere, never interpolated into script).
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
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
  const flowRef = formData.get("flow_ref");
  // Reuse the GET's ref so its log line and this one correlate under one grep; if it's missing
  // (tampered or pre-dates this field), fall back to a fresh one so this attempt is still traceable.
  const ref = typeof flowRef === "string" && flowRef ? flowRef : generateFlowRef();

  const cookieToken = extractCsrfCookie(request);
  const formToken = formData.get("csrf_token");
  if (!cookieToken || typeof formToken !== "string" || formToken !== cookieToken) {
    // Never log the token values themselves — just enough to tell a stale-page resubmission (the
    // common case: the consent page was loaded/rendered more than once, e.g. via browser back or a
    // duplicate tab, and an older copy's form was submitted after a newer one already consumed and
    // cleared the cookie) apart from the cookie never arriving at all (Access/proxy stripping it —
    // a config problem worth escalating) by listing which cookie *names* (not values) were present.
    const cookieNames = (request.headers.get("Cookie") ?? "")
      .split(";")
      .map((c) => c.trim().split("=")[0])
      .filter(Boolean);
    console.warn(
      `[authorize:${ref}] POST rejected: CSRF token mismatch.`,
      `cookiePresent=${cookieToken !== null}`,
      `formTokenPresent=${typeof formToken === "string"}`,
      `cookieNamesOnRequest=${JSON.stringify(cookieNames)}`,
    );
    return new Response(
      "Forbidden: missing or invalid CSRF token. This usually means the consent page was opened more " +
        "than once (e.g. via browser back, or a duplicate tab) and an already-used copy was submitted — " +
        `go back to claude.ai, remove this connector attempt, and add it again fresh. (ref: ${ref})`,
      { status: 403 },
    );
  }

  const reconstructedUrl = new URL("/authorize", request.url);
  for (const [name, value] of formData.entries()) {
    if (name === "csrf_token" || name === "flow_ref") continue;
    reconstructedUrl.searchParams.append(name, String(value));
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(reconstructedUrl));
  } catch (err) {
    console.error(`[authorize:${ref}] POST: parseAuthRequest failed:`, err instanceof Error ? err.message : err);
    return new Response(
      `Invalid authorization request: ${err instanceof Error ? err.message : "unknown error"} (ref: ${ref})`,
      { status: 400 },
    );
  }

  let redirectTo: string;
  try {
    ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: identity.email,
      scope: oauthReqInfo.scope,
      metadata: { label: identity.email },
      props: { email: identity.email } satisfies OAuthProps,
    }));
  } catch (err) {
    console.error(`[authorize:${ref}] POST: completeAuthorization threw:`, err instanceof Error ? err.message : err);
    return new Response(`Server error completing authorization. (ref: ${ref})`, { status: 500 });
  }

  console.log(`[authorize:${ref}] POST: approved, redirecting.`, `client_id=${oauthReqInfo.clientId}`, `to=${redirectTo}`);

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

      console.log(`[authorize] ${request.method} request received.`);

      const identity = await verifyAccessJwt(request, env);
      if (!identity) {
        // verifyAccessJwt already logged the specific reason (no token / verification error / email
        // mismatch); this response only needs a ref so the operator can point back at that log line.
        const ref = generateFlowRef();
        console.warn(`[authorize:${ref}] ${request.method}: rejected — Cloudflare Access did not authenticate this request.`);
        return new Response(`Forbidden: Cloudflare Access did not authenticate this request. (ref: ${ref})`, {
          status: 403,
        });
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
