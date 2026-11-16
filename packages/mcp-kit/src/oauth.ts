import { OAuthAuthorizationServer, OAuthResourceServer } from "@cloudflare/workers-oauth-provider";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { bearerTokenMatches } from "./auth.js";
import { verifyAccessJwt } from "./access.js";
import type { AccessJwtEnv } from "./access.js";

/**
 * Identity surfaced to MCP tool handlers for requests that authenticated via OAuth (Access-gated
 * `/authorize`). Extends `Record<string, unknown>` (rather than a plain `{ email: string }`) so it
 * satisfies `McpAgent`'s `Props` generic constraint directly — see each server's `agent.ts`.
 */
export interface OAuthProps extends Record<string, unknown> {
  email: string;
}

/** Everything `buildMultiServerOAuthWorker` needs beyond what the gateway's `Env` already declares. */
export interface OAuthMcpEnv extends AccessJwtEnv {
  MCP_SHARED_TOKEN: string;
  // The OAuth provider library reads/writes this KV binding directly at runtime; this package
  // never calls its methods itself, so (matching CacheNamespace's minimal-structural-type
  // convention above) it isn't worth depending on @cloudflare/workers-types just to name it.
  OAUTH_KV: unknown;
  /**
   * Set by `buildMultiServerOAuthWorker` on the env it hands the `/authorize` handler only (from
   * `OAuthAuthorizationServer.getOAuthApi`). Never set on the env MCP agents see, so
   * optional here: only `/authorize` code (typed with `AuthorizeEnv`) may rely on it.
   */
  OAUTH_PROVIDER?: OAuthHelpers;
  /**
   * Optional Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc) applied per client IP
   * to anonymous `POST /register`. Each registration is a 90-day `OAUTH_KV` write, so without it
   * anyone can spend the account's KV write and storage quota, which the token store shares.
   */
  REGISTER_RATE_LIMITER?: RateLimiterLike;
}

/** The one method of a Workers `RateLimit` binding used here, typed structurally (see `OAUTH_KV`). */
export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The authorization server's endpoints. Kept at their 0.x paths, so advertised metadata is unchanged. */
const AUTHORIZE_ENDPOINT = "/authorize";
const TOKEN_ENDPOINT = "/token";
const REGISTRATION_ENDPOINT = "/register";
const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/**
 * Largest body accepted on the anonymous `POST /token` and `POST /register` endpoints. Real
 * requests are a few hundred bytes. The library itself allows 1 MiB on /register, and nothing at
 * all on /token, whose form parser does work that grows with the square of the field count.
 */
export const MAX_ANONYMOUS_OAUTH_BODY_BYTES = 16 * 1024;

/** Reads at most `maxBytes` of the body, or returns null as soon as it is larger. */
async function readCappedBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function oauthErrorResponse(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Limits for the two OAuth endpoints anyone can POST to without credentials. Returns the request to
 * pass on (with its body already read, so the size cap holds even without a Content-Length), or the
 * error response to send instead.
 */
async function guardAnonymousOAuthPost(
  request: Request,
  env: OAuthMcpEnv,
  pathname: typeof TOKEN_ENDPOINT | typeof REGISTRATION_ENDPOINT,
): Promise<Request | Response> {
  // Cloudflare's edge always sets CF-Connecting-IP and overwrites any client value.
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (pathname === REGISTRATION_ENDPOINT && env.REGISTER_RATE_LIMITER && clientIp) {
    const { success } = await env.REGISTER_RATE_LIMITER.limit({ key: clientIp });
    if (!success) return oauthErrorResponse(429, "too_many_requests", "Too many client registrations. Try again in a minute.");
  }
  const body = await readCappedBody(request, MAX_ANONYMOUS_OAUTH_BODY_BYTES);
  if (body === null) {
    return oauthErrorResponse(413, "invalid_request", `Request body must be at most ${MAX_ANONYMOUS_OAUTH_BODY_BYTES} bytes.`);
  }
  return new Request(request, { body });
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
 * OAuth 2.1 and the MCP authorization spec both require PKCE with S256, so enforce exactly that here,
 * where the grant is made. Since workers-oauth-provider 1.2 the library refuses every method other
 * than S256 (a challenge with no method counts as plain) and a method with no challenge, but it
 * refuses a request with no PKCE parameters at all only for public clients (token_endpoint_auth_method
 * "none"). A confidential client sending no PKCE still reaches this check, so it remains the gate for
 * the full S256 rule.
 */
export function validatePkceS256(
  codeChallenge: string | undefined,
  codeChallengeMethod: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!codeChallenge) {
    return { ok: false, reason: "missing 'code_challenge' — PKCE with S256 is required" };
  }
  if (codeChallengeMethod !== "S256") {
    return { ok: false, reason: "'code_challenge_method' must be S256" };
  }
  return { ok: true };
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
async function renderAuthorizeConsent(
  request: Request,
  env: AuthorizeEnv,
): Promise<Response> {
  const ref = generateFlowRef();
  const url = new URL(request.url);
  console.log(`[authorize:${ref}] GET: resource param(s) observed:`, JSON.stringify(url.searchParams.getAll("resource")));

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

  const pkceCheck = validatePkceS256(oauthReqInfo.codeChallenge, oauthReqInfo.codeChallengeMethod);
  if (!pkceCheck.ok) {
    console.error(`[authorize:${ref}] GET: rejected — ${pkceCheck.reason}`);
    return new Response(`Invalid authorization request: ${pkceCheck.reason} (ref: ${ref})`, { status: 400 });
  }

  const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  const clientName = clientInfo?.clientName || oauthReqInfo.clientId;

  console.log(
    `[authorize:${ref}] GET: rendering consent page.`,
    `client_id=${oauthReqInfo.clientId}`,
    `redirect_uri=${oauthReqInfo.redirectUri}`,
  );

  // Echo every original query param back verbatim as hidden fields (not just the ones the parsed
  // AuthRequest names — this is how `resource` round-trips to the POST for re-validation there) so
  // a repeated param round-trips exactly, and so the POST handler can re-run parseAuthRequest on the
  // reconstructed URL instead of re-deriving it by hand. A crafted link could itself carry a
  // `csrf_token`/`flow_ref` param, which would render a hidden field ahead of the real one and shadow
  // it on submit (formData.get() returns the first match) — fail closed but an annoying self-DoS, so
  // both are dropped here; the ones appended below (the only ones that count) always come last.
  const hiddenInputs = [...url.searchParams.entries()]
    .filter(([name]) => name !== "csrf_token" && name !== "flow_ref")
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join("\n      ");

  // form-action stays 'self' only. Chrome and Safari re-check form-action against every hop of the
  // redirect chain a form submission starts, including hops the client's own callback adds (e.g.
  // Cursor's https://www.cursor.com/... callback redirecting on to another host). So POST /authorize
  // never redirects cross-origin itself: it answers 200 with a small page that navigates onward
  // (see renderRedirectPage), which ends the form navigation inside 'self'.

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
      // 'script-src nonce-...' (not 'none'): the inline script above only logs client-side
      // diagnostics and shows submit feedback — nothing it does touches untrusted data (clientName/
      // clientId/redirectUri are rendered as escaped text elsewhere, never interpolated into script).
      // 'form-action' is 'self' only: the POST answers same-origin (see renderRedirectPage).
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

/** Completes `POST /authorize` after the consent form is submitted: validates the CSRF token, then grants. */
async function completeAuthorizeConsent(
  request: Request,
  env: AuthorizeEnv,
  identity: { email: string },
): Promise<Response> {
  const formData = await request.formData();
  const flowRefField = formData.get("flow_ref");
  // Reuse the GET's ref so its log line and this one correlate under one grep; if it's missing,
  // malformed, or oversized (a tampered submission — this is client-controlled form data), fall
  // back to a fresh one instead, so an attacker can't inject arbitrary text into log lines or
  // response bodies via this field. generateFlowRef() only ever produces 8 lowercase hex chars.
  const ref =
    typeof flowRefField === "string" && /^[0-9a-f]{8}$/.test(flowRefField) ? flowRefField : generateFlowRef();

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
  console.log(`[authorize:${ref}] POST: resource param(s) observed:`, JSON.stringify(reconstructedUrl.searchParams.getAll("resource")));

  // Re-parsed here, not trusted from the GET: every hidden field is client-controlled. The library's
  // parseAuthRequest re-checks the `resource` (exactly one registered server) and the redirect URI.
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

  const pkceCheck = validatePkceS256(oauthReqInfo.codeChallenge, oauthReqInfo.codeChallengeMethod);
  if (!pkceCheck.ok) {
    console.error(`[authorize:${ref}] POST: rejected — ${pkceCheck.reason}`);
    return new Response(`Invalid authorization request: ${pkceCheck.reason} (ref: ${ref})`, { status: 400 });
  }

  let redirectTo: string;
  try {
    ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: identity.email,
      scope: oauthReqInfo.scope,
      metadata: { label: identity.email },
      props: { email: identity.email } satisfies OAuthProps,
      // Every server now shares one authorization server and one userId (the operator email). If a
      // client reuses one DCR client_id across connectors on this issuer (plausible for claude.ai,
      // which registers per-connection but the registration TTL is long), the library's default
      // (revoke every existing grant for this userId+clientId) would silently kill an unrelated
      // connector's grant the moment a new one is approved. Concurrent grants per user+client are
      // exactly what a multi-server gateway needs, so this must stay false.
      revokeExistingGrants: false,
    }));
  } catch (err) {
    console.error(`[authorize:${ref}] POST: completeAuthorization threw:`, err instanceof Error ? err.message : err);
    return new Response(`Server error completing authorization. (ref: ${ref})`, { status: 500 });
  }

  // Never log redirectTo itself: completeAuthorization() appends the OAuth authorization code (and
  // state, if present) to the client's redirect_uri as query params — origin+path is enough to
  // confirm which client/URL a grant redirected to without putting a live code in Workers Logs.
  const redirectDestination = new URL(redirectTo);
  console.log(
    `[authorize:${ref}] POST: approved, redirecting.`,
    `client_id=${oauthReqInfo.clientId}`,
    `to=${redirectDestination.origin}${redirectDestination.pathname}`,
  );

  return renderRedirectPage(redirectTo, ref);
}

/**
 * The response to a successful `POST /authorize`: a 200 page that sends the browser on to the
 * client's redirect_uri, instead of a 302. A 302 keeps the browser inside the form submission's
 * navigation, where Chrome and Safari check `form-action` against every later redirect hop too. A
 * client callback that itself redirects to another host (Cursor's www.cursor.com callback did this)
 * then gets blocked silently and the consent page sits on "Submitting…" for ever, even though the
 * grant was created. Navigating from a fresh page is not a form submission, so form-action no longer
 * applies. Three ways on, so one always works: a nonce script (handles custom-scheme redirect_uris
 * like cursor:// that some browsers refuse via meta refresh), a meta refresh (no-JS), and a link.
 */
function renderRedirectPage(redirectTo: string, ref: string): Response {
  const nonce = crypto.randomUUID();
  const target = escapeHtml(redirectTo);
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0;url=${target}" />
    <title>Authorized</title>
  </head>
  <body>
    <h1>Authorized</h1>
    <p>Returning you to the app. If nothing happens, <a id="continue" href="${target}">continue here</a>.</p>
    <p><small>Reference: <code>${escapeHtml(ref)}</code></small></p>
    <script nonce="${nonce}">
      window.location.replace(document.getElementById("continue").href);
    </script>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `${CSRF_COOKIE_NAME}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
      "X-Frame-Options": "DENY",
      // The target URL carries a live authorization code, so keep this page's URL (and anything
      // else) out of the Referer the client receives, and out of any cache.
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

/**
 * Everything `buildMultiServerOAuthWorker` doesn't route to an OAuth role: serves `/authorize`, gated by the one Cloudflare Access
 * application scoped to that path, and delegates every other non-API path (the portal UI, and
 * anything else) to `portal`. `GET /authorize` renders a consent page (see `renderAuthorizeConsent`);
 * `POST /authorize` (the page's own form submit) completes the grant. Access authentication is
 * re-verified on both methods — the JWT alone answers "who," never "did they mean to approve this
 * specific client." The portal is responsible for its own authorization in code (see
 * `docs/SETUP.md` — this hostname can no longer be entirely covered by one Access application, since
 * `/token`, `/register`, and `/.well-known/*` must stay public for machine-to-machine calls).
 */
export function createAccessAuthorizeHandler<Env extends AccessJwtEnv & { OAUTH_PROVIDER?: OAuthHelpers }>(
  portal: { fetch(request: Request, env: Env, ctx: unknown): Response | Promise<Response> },
): {
  fetch(request: Request, env: Env, ctx: unknown): Promise<Response>;
} {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname !== AUTHORIZE_ENDPOINT) {
        return portal.fetch(request, env, ctx);
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

      const helpers = env.OAUTH_PROVIDER;
      if (!helpers) {
        // buildMultiServerOAuthWorker sets this for /authorize; reaching here without it is a wiring bug.
        console.error("[authorize] OAUTH_PROVIDER is not set on this request's env.");
        return new Response("Server error: OAuth is not configured for this request.", { status: 500 });
      }
      const authorizeEnv: AuthorizeEnv = { ...env, OAUTH_PROVIDER: helpers };
      if (request.method === "GET") return renderAuthorizeConsent(request, authorizeEnv);
      if (request.method === "POST") return completeAuthorizeConsent(request, authorizeEnv, identity);
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

/** One MCP server's registration in the gateway: its URL slug, `McpAgent` subclass, and DO binding name. */
export interface McpServerRegistration<Env> {
  /** URL path prefix, e.g. `"ia"` → served at `/ia/mcp`. */
  slug: string;
  /** The `McpAgent` subclass for this server. */
  agent: McpAgentClass<Env>;
  /** Durable Object binding name in `wrangler.jsonc`, e.g. `"IA_MCP"`. */
  binding: string;
}

/** The OAuth roles for one origin: the shared authorization server and one resource server per MCP path. */
interface OAuthRoles<Env> {
  authorizationServer: OAuthAuthorizationServer<Env>;
  /** Keyed by `/{slug}/mcp`. */
  resourceServers: Map<string, OAuthResourceServer<Env, OAuthProps>>;
}

/** Paths the authorization server itself answers (RFC 8414 metadata, token and revocation, DCR). */
const AUTHORIZATION_SERVER_PATHS: ReadonlySet<string> = new Set([
  AUTHORIZATION_SERVER_METADATA_PATH,
  TOKEN_ENDPOINT,
  REGISTRATION_ENDPOINT,
]);
const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

/** Most origins the roles cache keeps. Production serves one; this only stops unbounded growth. */
const MAX_CACHED_ORIGINS = 4;

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/** `/{slug}/mcp` that `pathname` is, or sits under (`/{slug}/mcp/...`), if any. */
function findMcpPath(pathname: string, mcpPaths: Iterable<string>): string | undefined {
  for (const mcpPath of mcpPaths) {
    if (pathname === mcpPath || pathname.startsWith(`${mcpPath}/`)) return mcpPath;
  }
  return undefined;
}

/**
 * Wraps every MCP server's `McpAgent` class with one shared OAuth 2.1 + PKCE authorization server
 * (via `@cloudflare/workers-oauth-provider` 1.x), path-routed at `/{slug}/mcp`, while preserving the
 * existing static bearer token for server-to-server clients (Claude Code) that can't complete an
 * interactive login. Requests to a registered `/{slug}/mcp` path carrying the exact
 * `MCP_SHARED_TOKEN` bypass OAuth entirely.
 *
 * The library's role classes do the rest. One `OAuthAuthorizationServer` declares every
 * `https://<host>/{slug}/mcp` as a separate resource, and serves `/token`, `/register` and
 * `/.well-known/oauth-authorization-server`. Each path gets its own `OAuthResourceServer`, which
 * publishes `/.well-known/oauth-protected-resource/{slug}/mcp`, answers a token-less request with
 * `401 + WWW-Authenticate: Bearer resource_metadata=…` (what triggers claude.ai's OAuth handshake),
 * and accepts only tokens whose audience is exactly its own resource. `/authorize` and the portal
 * are `createAccessAuthorizeHandler`.
 *
 * Per-server token isolation therefore comes from the library: `parseAuthRequest` and
 * `completeAuthorization` refuse an authorization whose `resource` is missing, repeated with
 * different values, or not one declared server (an origin-only value covers none of them), and each
 * resource server refuses another server's token. This replaced a hand-written check on 0.x, whose
 * single `OAuthProvider` treated an origin-only audience as valid on every path.
 *
 * Why not one `OAuthProvider` with an origin-wide resource: in 1.x a token's audience is compared
 * exactly, and every grant made under 0.x carries its own `/{slug}/mcp` path. An origin resource
 * would sign out every existing connector and make each new token valid on every server.
 *
 * The roles are built per origin, because the hostname is a secret read only at request time.
 * One token store (`OAUTH_KV`) still serves every server, so a bug or leak in OAuth storage is not
 * isolated per server — see `docs/SETUP.md`.
 */
export function buildMultiServerOAuthWorker<Env extends OAuthMcpEnv>(
  servers: readonly McpServerRegistration<Env>[],
  portal: { fetch(request: Request, env: Env, ctx: unknown): Response | Promise<Response> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { fetch(request: Request, env: Env, ctx: any): Promise<Response> } {
  const mcpHandlers = new Map<string, ReturnType<McpAgentClass<Env>["serve"]>>(
    servers.map((s) => [`/${s.slug}/mcp`, s.agent.serve(`/${s.slug}/mcp`, { binding: s.binding })]),
  );
  const authorizeHandler = createAccessAuthorizeHandler<Env>(portal);
  const rolesByOrigin = new Map<string, OAuthRoles<Env>>();

  function rolesFor(origin: string): OAuthRoles<Env> {
    const cached = rolesByOrigin.get(origin);
    if (cached) {
      // Re-insert on every hit, so Map order is least-recently-used first.
      rolesByOrigin.delete(origin);
      rolesByOrigin.set(origin, cached);
      return cached;
    }
    const resources = [...mcpHandlers.keys()].map((path) => `${origin}${path}`);
    const authorizationServer = new OAuthAuthorizationServer<Env>({
      issuer: origin,
      resources,
      // No defaultResource: an authorization request must name its server. No legacyGrantResource:
      // every production grant made under 0.x already carries one (checked 2026-11-16).
      authorizeEndpoint: AUTHORIZE_ENDPOINT,
      // Kept at /token (1.x would default to /oauth/token) so the advertised metadata, and every
      // client that cached it, stays the same as under 0.x.
      tokenEndpoint: TOKEN_ENDPOINT,
      clientRegistrationEndpoint: REGISTRATION_ENDPOINT,
    });
    const resourceServers = new Map(
      [...mcpHandlers].map(([path, handler]) => [
        path,
        new OAuthResourceServer<Env, OAuthProps>({
          resourceMetadata: { resource: `${origin}${path}`, authorization_servers: [origin] },
          validateToken: (env) => (resource, token) => authorizationServer.validateToken<OAuthProps>(resource, token, env),
          handler,
        }),
      ]),
    );
    const roles = { authorizationServer, resourceServers };
    // Evict the least recently used origin only, so a client cycling extra hostnames or ports can't
    // knock the busy real origin's roles out of the cache.
    const oldest = rolesByOrigin.keys().next();
    if (rolesByOrigin.size >= MAX_CACHED_ORIGINS && !oldest.done) rolesByOrigin.delete(oldest.value);
    rolesByOrigin.set(origin, roles);
    return roles;
  }

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);

      // 1.x only accepts an https issuer and resource (http only on loopback, for `wrangler dev`), so
      // plain http on the real hostname is sent to https rather than failing the constructor. This
      // runs before the shared-token bypass too, so no request is ever served over plain http.
      if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
        url.protocol = "https:";
        return Response.redirect(url.toString(), 308);
      }

      const direct = mcpHandlers.get(url.pathname);
      if (direct && bearerTokenMatches(request, env.MCP_SHARED_TOKEN)) {
        return direct.fetch(request, env, ctx);
      }

      const mcpPath = findMcpPath(url.pathname, mcpHandlers.keys());
      const isProtectedResourceMetadata =
        url.pathname === PROTECTED_RESOURCE_METADATA_PREFIX || url.pathname.startsWith(`${PROTECTED_RESOURCE_METADATA_PREFIX}/`);
      const needsOAuth =
        mcpPath !== undefined ||
        isProtectedResourceMetadata ||
        AUTHORIZATION_SERVER_PATHS.has(url.pathname) ||
        url.pathname === AUTHORIZE_ENDPOINT;
      // The landing page and the portal need no OAuth role, so they never build or wait on one.
      if (!needsOAuth) return authorizeHandler.fetch(request, env, ctx);

      let roles: OAuthRoles<Env>;
      try {
        roles = rolesFor(url.origin);
      } catch (err) {
        // The library refused this origin as an issuer or resource (isLoopbackHost and its own rule
        // disagree on some host). Refuse the request rather than answering with an unhandled 500.
        console.error(`[oauth] cannot serve OAuth on origin ${url.origin}:`, err instanceof Error ? err.message : err);
        return new Response("OAuth is not available on this origin.", { status: 421 });
      }

      if (mcpPath) return roles.resourceServers.get(mcpPath)!.fetch(request, env, ctx);

      if (isProtectedResourceMetadata) {
        const metadataPath = findMcpPath(url.pathname.slice(PROTECTED_RESOURCE_METADATA_PREFIX.length), mcpHandlers.keys());
        if (metadataPath) return roles.resourceServers.get(metadataPath)!.fetch(request, env, ctx);
        return new Response(null, { status: 404 });
      }

      if (AUTHORIZATION_SERVER_PATHS.has(url.pathname)) {
        if (request.method === "POST" && (url.pathname === TOKEN_ENDPOINT || url.pathname === REGISTRATION_ENDPOINT)) {
          const guarded = await guardAnonymousOAuthPost(request, env, url.pathname);
          if (guarded instanceof Response) return guarded;
          return roles.authorizationServer.fetch(guarded, env, ctx);
        }
        return roles.authorizationServer.fetch(request, env, ctx);
      }

      // Only /authorize is left. The helpers go on a copy, so helpers bound to this origin's
      // authorization server never leak onto the shared env object MCP agents and later requests see.
      return authorizeHandler.fetch(request, { ...env, OAUTH_PROVIDER: roles.authorizationServer.getOAuthApi(env) }, ctx);
    },
  };
}
