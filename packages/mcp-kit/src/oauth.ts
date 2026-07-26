import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
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
  OAUTH_PROVIDER: OAuthHelpers;
  /**
   * Escape hatch for cutover: set to the exact string `"true"` to disable the per-path `resource`
   * enforcement in `/authorize` (see `validateResourceForRegisteredPath`) if a real client turns
   * out not to send an RFC 8707 `resource` parameter the way claude.ai is expected to. Unset (the
   * default) enforces it. Every `/authorize` request logs the raw `resource` value(s) it observed
   * regardless of this flag, so the first real connector attempt confirms the assumption either way.
   */
  DISABLE_RESOURCE_ENFORCEMENT?: string;
}

type AuthorizeEnv = AccessJwtEnv & { OAUTH_PROVIDER: OAuthHelpers; DISABLE_RESOURCE_ENFORCEMENT?: string };

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
 * Guards the finding that one shared authorization server now covers every `/{slug}/mcp` path:
 * `handleApiRequest` only checks a token's audience when the token *has* one, which requires the
 * client to have sent an RFC 8707 `resource` parameter — and even then, `audienceMatches` treats an
 * origin-only audience (no path) as matching every path (`pathname === "/" || pathname === ""`).
 * Neither the OAuth spec nor the library forces a client to pick a specific, correctly-scoped
 * `resource`, so this enforces it ourselves at the one place a request can supply it: `/authorize`.
 * Requires exactly one `resource`, same-origin, whose path is one of the servers actually
 * registered — otherwise a token minted here would be usable at every other server in the fleet.
 */
export function validateResourceForRegisteredPath(
  resource: string | string[] | undefined,
  requestOrigin: string,
  registeredResourcePaths: ReadonlySet<string>,
): { ok: true } | { ok: false; reason: string } {
  if (resource === undefined) {
    return { ok: false, reason: "missing 'resource' parameter — must name exactly one registered MCP server" };
  }
  if (Array.isArray(resource)) {
    return { ok: false, reason: "multiple 'resource' parameters — must name exactly one registered MCP server" };
  }
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    return { ok: false, reason: `'resource' is not an absolute URI: ${resource}` };
  }
  if (parsed.origin !== requestOrigin) {
    return { ok: false, reason: `'resource' origin (${parsed.origin}) does not match this server (${requestOrigin})` };
  }
  if (parsed.pathname === "/" || parsed.pathname === "") {
    return {
      ok: false,
      reason: "'resource' is origin-only (no path) — this library treats that as matching every server's path",
    };
  }
  if (!registeredResourcePaths.has(parsed.pathname)) {
    return { ok: false, reason: `'resource' path (${parsed.pathname}) is not a registered MCP server` };
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
async function renderAuthorizeConsent<Env extends AuthorizeEnv>(
  request: Request,
  env: Env,
  registeredResourcePaths: ReadonlySet<string>,
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

  if (env.DISABLE_RESOURCE_ENFORCEMENT !== "true") {
    const resourceCheck = validateResourceForRegisteredPath(oauthReqInfo.resource, url.origin, registeredResourcePaths);
    if (!resourceCheck.ok) {
      console.error(`[authorize:${ref}] GET: rejected — ${resourceCheck.reason}`);
      return new Response(`Invalid authorization request: ${resourceCheck.reason} (ref: ${ref})`, { status: 400 });
    }
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

  // Chrome and Safari (unlike Firefox) re-check `form-action` against each hop of a redirect chain
  // that results from a form submission, not just the submission's own same-origin URL — so a POST
  // to /authorize that succeeds and 302s to the client's (cross-origin) redirect_uri gets silently
  // blocked by a bare `form-action 'self'`, with no visible error on the page. oauthReqInfo.redirectUri
  // is already validated by parseAuthRequest against the registered client's redirect_uris above, so
  // it's safe to allowlist. (Confirmed against Chromium issue 40923007 / content-security-policy.com.)
  let redirectOrigin: string | null = null;
  try {
    redirectOrigin = new URL(oauthReqInfo.redirectUri).origin;
  } catch {
    // Shouldn't happen — parseAuthRequest already validated this as an absolute URI — but fail
    // closed to 'self' only rather than throwing and losing the whole consent page over it.
  }
  const formActionSources = ["'self'", ...(redirectOrigin ? [redirectOrigin] : [])].join(" ");

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
      // 'form-action' includes the validated redirect_uri's origin, not just 'self' — see above.
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${formActionSources}; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

/** Completes `POST /authorize` after the consent form is submitted: validates the CSRF token, then grants. */
async function completeAuthorizeConsent<Env extends AuthorizeEnv>(
  request: Request,
  env: Env,
  identity: { email: string },
  registeredResourcePaths: ReadonlySet<string>,
): Promise<Response> {
  const formData = await request.formData();
  const flowRefField = formData.get("flow_ref");
  // Reuse the GET's ref so its log line and this one correlate under one grep; if it's missing
  // (tampered or pre-dates this field), fall back to a fresh one so this attempt is still traceable.
  const ref = typeof flowRefField === "string" && flowRefField ? flowRefField : generateFlowRef();

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

  // Re-validated here, not just on GET: the hidden `resource` field is client-controlled and could
  // be tampered with between the two requests (a scripted client can skip rendering the page at all).
  if (env.DISABLE_RESOURCE_ENFORCEMENT !== "true") {
    const resourceCheck = validateResourceForRegisteredPath(
      oauthReqInfo.resource,
      new URL(request.url).origin,
      registeredResourcePaths,
    );
    if (!resourceCheck.ok) {
      console.error(`[authorize:${ref}] POST: rejected — ${resourceCheck.reason}`);
      return new Response(`Invalid authorization request: ${resourceCheck.reason} (ref: ${ref})`, { status: 400 });
    }
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
 * The OAuth provider's `defaultHandler`: serves `/authorize`, gated by the one Cloudflare Access
 * application scoped to that path, and delegates every other non-API path (the portal UI, and
 * anything else) to `portal`. `GET /authorize` renders a consent page (see `renderAuthorizeConsent`);
 * `POST /authorize` (the page's own form submit) completes the grant. Access authentication is
 * re-verified on both methods — the JWT alone answers "who," never "did they mean to approve this
 * specific client." The portal is responsible for its own authorization in code (see
 * `docs/SETUP.md` — this hostname can no longer be entirely covered by one Access application, since
 * `/token`, `/register`, and `/.well-known/*` must stay public for machine-to-machine calls).
 */
export function createAccessAuthorizeHandler<Env extends AuthorizeEnv>(
  portal: { fetch(request: Request, env: Env, ctx: unknown): Response | Promise<Response> },
  registeredResourcePaths: ReadonlySet<string>,
): {
  fetch(request: Request, env: Env, ctx: unknown): Promise<Response>;
} {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname !== "/authorize") {
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

      if (request.method === "GET") return renderAuthorizeConsent(request, env, registeredResourcePaths);
      if (request.method === "POST") return completeAuthorizeConsent(request, env, identity, registeredResourcePaths);
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

/**
 * Wraps every MCP server's `McpAgent` class with one shared OAuth 2.1 + PKCE authorization server
 * (via `@cloudflare/workers-oauth-provider`), path-routed at `/{slug}/mcp`, while preserving the
 * existing static bearer token for server-to-server clients (Claude Code) that can't complete an
 * interactive login. Requests to a registered `/{slug}/mcp` path carrying the exact
 * `MCP_SHARED_TOKEN` bypass the OAuth provider entirely; every other request — including a
 * token-less or wrong-token request to one of those paths — flows through the provider, which
 * returns the spec-correct `401 + WWW-Authenticate: Bearer resource_metadata=…` (path-suffixed per
 * RFC 9728, derived automatically per request by the library — no per-server config needed) that
 * triggers claude.ai's OAuth handshake, and serves `/token`, `/register`, `/authorize`, and the
 * `.well-known` discovery documents — all shared, at the hostname root, across every server.
 *
 * One authorization server for every server means one token store (`OAUTH_KV`): a bug or leak in
 * OAuth storage is no longer isolated per server, unlike the previous one-Worker-per-server layout.
 * The per-path `resource`/audience enforcement in `createAccessAuthorizeHandler` is what partially
 * replaces that isolation — see its docstring and `docs/SETUP.md`.
 */
export function buildMultiServerOAuthWorker<Env extends OAuthMcpEnv>(
  servers: readonly McpServerRegistration<Env>[],
  portal: { fetch(request: Request, env: Env, ctx: unknown): Response | Promise<Response> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { fetch(request: Request, env: Env, ctx: any): Promise<Response> } {
  const mcpHandlers = new Map<string, ReturnType<McpAgentClass<Env>["serve"]>>(
    servers.map((s) => [`/${s.slug}/mcp`, s.agent.serve(`/${s.slug}/mcp`, { binding: s.binding })]),
  );
  const registeredResourcePaths = new Set(mcpHandlers.keys());

  const provider = new OAuthProvider<Env>({
    apiHandlers: Object.fromEntries(mcpHandlers),
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // OAuth 2.1 drops plain PKCE; only accept/advertise S256.
    allowPlainPKCE: false,
    defaultHandler: createAccessAuthorizeHandler<Env>(portal, registeredResourcePaths),
  });

  return {
    fetch(request, env, ctx) {
      const url = new URL(request.url);
      const direct = mcpHandlers.get(url.pathname);
      if (direct && bearerTokenMatches(request, env.MCP_SHARED_TOKEN)) {
        return direct.fetch(request, env, ctx);
      }
      return provider.fetch(request, env, ctx);
    },
  };
}
