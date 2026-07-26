import { exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __setAccessJwksResolverForTesting } from "@iolab/mcp-kit/access";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

// Collapsed from seven per-server suites (nz-govt-mcp, nz-culture-mcp, ...) that differed only by
// ORIGIN — see docs/SETUP.md and the gateway plan's Part 4. All 8 servers now share one
// authorization server at this one origin.
const ORIGIN = "https://mcp.example.com";
const ACCESS_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ACCESS_AUD = "test-aud-tag";
const ACCESS_EMAIL = "operator@example.com";

/** Resource URL for a registered server path, e.g. resourceFor("nz-govt") -> ORIGIN + "/nz-govt/mcp". */
function resourceFor(slug: string): string {
  return `${ORIGIN}/${slug}/mcp`;
}

interface AuthorizationServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  code_challenge_methods_supported: string[];
}

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
}

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
}

async function base64UrlSha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function extractCsrfToken(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /__Host-OAUTH_CSRF=([^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error("consent page response missing the CSRF cookie");
  return match[1];
}

async function registerClient(body: Record<string, unknown> = {}): Promise<RegisteredClient> {
  const response = await exports.default.fetch(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example.com/callback"],
        token_endpoint_auth_method: "none",
        ...body,
      }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as RegisteredClient;
}

/**
 * Runs a full DCR + PKCE + consent-approval authorization flow for `resource` (a full
 * `${ORIGIN}/{slug}/mcp` URL, or `undefined`/`null` to omit the parameter — used by the
 * enforcement-rejection tests below) against a given `client`, and returns the resulting access
 * token. Asserts nothing beyond what's needed to get the token — callers assert on top of it.
 */
async function authorizeAndGetToken(
  signAccessJwt: (claims?: Record<string, unknown>) => Promise<string>,
  client: RegisteredClient,
  resource: string,
): Promise<string> {
  const [redirectUri] = client.redirect_uris;
  if (!redirectUri) throw new Error("registration response missing redirect_uris");

  const codeVerifier = `verifier-${crypto.randomUUID()}`;
  const codeChallenge = await base64UrlSha256(codeVerifier);

  const accessJwt = await signAccessJwt();
  const authorizeUrl = new URL(`${ORIGIN}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", crypto.randomUUID());
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", resource);

  const consentResponse = await exports.default.fetch(
    new Request(authorizeUrl, { headers: { "Cf-Access-Jwt-Assertion": accessJwt } }),
  );
  expect(consentResponse.status).toBe(200);
  const csrfToken = extractCsrfToken(consentResponse);

  const approveBody = new URLSearchParams(authorizeUrl.searchParams);
  approveBody.set("csrf_token", csrfToken);
  const authorizeResponse = await exports.default.fetch(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "Cf-Access-Jwt-Assertion": accessJwt,
        Cookie: `__Host-OAUTH_CSRF=${csrfToken}`,
      },
      body: approveBody,
      redirect: "manual",
    }),
  );
  expect(authorizeResponse.status).toBe(302);
  const redirectUrl = new URL(authorizeResponse.headers.get("location") as string);
  const code = redirectUrl.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenResponse = await exports.default.fetch(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: codeVerifier,
      }),
    }),
  );
  expect(tokenResponse.status).toBe(200);
  const tokenBody = (await tokenResponse.json()) as TokenResponse;
  expect(tokenBody.access_token).toBeTruthy();
  return tokenBody.access_token as string;
}

describe("OAuth (buildMultiServerOAuthWorker)", () => {
  let signAccessJwt: (claims?: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] });
    __setAccessJwksResolverForTesting(() => jwks);

    signAccessJwt = (claims = {}) =>
      new SignJWT({ email: ACCESS_EMAIL, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuedAt()
        .setIssuer(`https://${ACCESS_TEAM_DOMAIN}`)
        .setAudience(ACCESS_AUD)
        .setExpirationTime("5m")
        .sign(privateKey);
  });

  afterAll(() => {
    __setAccessJwksResolverForTesting(undefined);
  });

  it("returns 401 with a resource_metadata WWW-Authenticate challenge for an unauthenticated /nz-govt/mcp request", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/nz-govt/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/nz-govt/mcp"`);
  });

  it("serves RFC 8414 authorization server metadata (shared, at the hostname root) advertising S256-only PKCE", async () => {
    const response = await exports.default.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as AuthorizationServerMetadata;
    expect(metadata.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
    expect(metadata.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(metadata.registration_endpoint).toBe(`${ORIGIN}/register`);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("serves RFC 9728 protected resource metadata per path, not shared across servers", async () => {
    const govtMeta = (await (
      await exports.default.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/nz-govt/mcp`))
    ).json()) as ProtectedResourceMetadata;
    expect(govtMeta.resource).toBe(resourceFor("nz-govt"));

    const geoMeta = (await (
      await exports.default.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/nz-geo/mcp`))
    ).json()) as ProtectedResourceMetadata;
    expect(geoMeta.resource).toBe(resourceFor("nz-geo"));

    expect(govtMeta.resource).not.toBe(geoMeta.resource);
  });

  it("rejects /authorize with no Access JWT", async () => {
    const response = await exports.default.fetch(
      new Request(
        `${ORIGIN}/authorize?response_type=code&client_id=x&redirect_uri=https://client.example.com/cb&resource=${encodeURIComponent(resourceFor("nz-govt"))}`,
      ),
    );
    expect(response.status).toBe(403);
  });

  it("rejects /authorize with an Access JWT for the wrong email", async () => {
    const wrongEmailJwt = await signAccessJwt({ email: "someone-else@example.com" });
    const response = await exports.default.fetch(
      new Request(
        `${ORIGIN}/authorize?response_type=code&client_id=x&redirect_uri=https://client.example.com/cb&resource=${encodeURIComponent(resourceFor("nz-govt"))}`,
        { headers: { "Cf-Access-Jwt-Assertion": wrongEmailJwt } },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("renders a consent page for GET /authorize, escaping an attacker-controlled client name, with a diagnostic reference and nonce-scoped CSP", async () => {
    const client = await registerClient({ client_name: "<script>alert(1)</script>" });
    const [redirectUri] = client.redirect_uris;
    if (!redirectUri) throw new Error("registration response missing redirect_uris");

    const accessJwt = await signAccessJwt();
    const authorizeUrl = new URL(`${ORIGIN}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", "consent-state");
    authorizeUrl.searchParams.set("code_challenge", await base64UrlSha256("consent-page-verifier-1234567890"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", resourceFor("nz-govt"));

    const consentResponse = await exports.default.fetch(
      new Request(authorizeUrl, { headers: { "Cf-Access-Jwt-Assertion": accessJwt } }),
    );
    expect(consentResponse.status).toBe(200);
    expect(consentResponse.headers.get("cache-control")).toBe("no-store");
    const html = await consentResponse.text();
    expect(html).toContain(client.client_id);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(extractCsrfToken(consentResponse)).toBeTruthy();

    const csp = consentResponse.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f-]+'/);
    const visibleRefMatch = /Reference: <code>([0-9a-f]+)<\/code>/.exec(html);
    expect(visibleRefMatch?.[1]).toBeTruthy();
    expect(html).toContain(`<input type="hidden" name="flow_ref" value="${visibleRefMatch?.[1]}" />`);

    const formAction = /form-action ([^;]+);/.exec(csp)?.[1] ?? "";
    expect(formAction.split(" ")).toEqual(expect.arrayContaining(["'self'", "https://client.example.com"]));
  });

  it("doesn't let a crafted csrf_token query param shadow the real one on the consent page", async () => {
    const client = await registerClient();
    const [redirectUri] = client.redirect_uris;
    if (!redirectUri) throw new Error("registration response missing redirect_uris");

    const accessJwt = await signAccessJwt();
    const authorizeUrl = new URL(`${ORIGIN}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", "shadow-state");
    authorizeUrl.searchParams.set("code_challenge", await base64UrlSha256("shadow-test-verifier-1234567890"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", resourceFor("nz-govt"));
    authorizeUrl.searchParams.set("csrf_token", "attacker-supplied-value");

    const consentResponse = await exports.default.fetch(
      new Request(authorizeUrl, { headers: { "Cf-Access-Jwt-Assertion": accessJwt } }),
    );
    expect(consentResponse.status).toBe(200);
    const html = await consentResponse.text();
    expect(html).not.toContain("attacker-supplied-value");
    expect(html.match(/name="csrf_token"/g)).toHaveLength(1);
    expect(html).toContain(`value="${extractCsrfToken(consentResponse)}"`);
  });

  it("rejects POST /authorize with a missing or mismatched CSRF token, including a diagnostic reference", async () => {
    const accessJwt = await signAccessJwt();
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": accessJwt },
        body: new URLSearchParams({
          response_type: "code",
          client_id: "does-not-matter",
          redirect_uri: "https://client.example.com/callback",
          resource: resourceFor("nz-govt"),
          csrf_token: "attacker-guessed-token",
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/\(ref: [0-9a-f-]+\)/);
  });

  it("rejects POST /authorize when the CSRF cookie is present but doesn't match the form token", async () => {
    const accessJwt = await signAccessJwt();
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "Cf-Access-Jwt-Assertion": accessJwt,
          Cookie: "__Host-OAUTH_CSRF=cookie-value-that-does-not-match",
        },
        body: new URLSearchParams({
          response_type: "code",
          client_id: "does-not-matter",
          redirect_uri: "https://client.example.com/callback",
          resource: resourceFor("nz-govt"),
          csrf_token: "a-different-value-the-attacker-guessed",
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects POST /authorize with no Access JWT", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          response_type: "code",
          client_id: "does-not-matter",
          redirect_uri: "https://client.example.com/callback",
          resource: resourceFor("nz-govt"),
          csrf_token: "irrelevant-since-identity-is-checked-first",
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects GET /authorize for an unregistered client_id", async () => {
    const accessJwt = await signAccessJwt();
    const response = await exports.default.fetch(
      new Request(
        `${ORIGIN}/authorize?response_type=code&client_id=does-not-exist&redirect_uri=https://client.example.com/cb&resource=${encodeURIComponent(resourceFor("nz-govt"))}`,
        { headers: { "Cf-Access-Jwt-Assertion": accessJwt } },
      ),
    );
    expect(response.status).toBe(400);
  });

  it("completes the authorization flow end-to-end via the consent page, and the resulting token calls /nz-govt/mcp", async () => {
    const client = await registerClient();
    const token = await authorizeAndGetToken(signAccessJwt, client, resourceFor("nz-govt"));

    const mcpResponse = await exports.default.fetch(
      new Request(`${ORIGIN}/nz-govt/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.0" },
          },
        }),
      }),
    );
    expect(mcpResponse.status).not.toBe(401);
  });

  it("PKCE: a mismatched verifier is rejected without consuming the code, and the matching verifier still redeems it afterwards", async () => {
    const client = await registerClient();
    const [redirectUri] = client.redirect_uris;
    if (!redirectUri) throw new Error("registration response missing redirect_uris");

    const codeVerifier = "pkce-regression-verifier-1234567890";
    const codeChallenge = await base64UrlSha256(codeVerifier);
    const accessJwt = await signAccessJwt();
    const authorizeUrl = new URL(`${ORIGIN}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", "pkce-state");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", resourceFor("nz-govt"));

    const consentResponse = await exports.default.fetch(
      new Request(authorizeUrl, { headers: { "Cf-Access-Jwt-Assertion": accessJwt } }),
    );
    const csrfToken = extractCsrfToken(consentResponse);
    const approveBody = new URLSearchParams(authorizeUrl.searchParams);
    approveBody.set("csrf_token", csrfToken);
    const authorizeResponse = await exports.default.fetch(
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "Cf-Access-Jwt-Assertion": accessJwt,
          Cookie: `__Host-OAUTH_CSRF=${csrfToken}`,
        },
        body: approveBody,
        redirect: "manual",
      }),
    );
    const code = new URL(authorizeResponse.headers.get("location") as string).searchParams.get("code");

    const wrongVerifierResponse = await exports.default.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: redirectUri,
          client_id: client.client_id,
          code_verifier: "totally-different-verifier-that-does-not-match-1234567890",
        }),
      }),
    );
    expect(wrongVerifierResponse.status).toBe(400);

    const tokenResponse = await exports.default.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code as string,
          redirect_uri: redirectUri,
          client_id: client.client_id,
          code_verifier: codeVerifier,
        }),
      }),
    );
    expect(tokenResponse.status).toBe(200);
  });
});

describe("path routing", () => {
  // Tool prefixes don't always match the slug verbatim — nz-environment-mcp abbreviates to
  // nz_env_*, so this is an explicit table rather than derived from the slug string.
  const REGISTERED_SERVERS: Array<[slug: string, toolPrefix: string]> = [
    ["nz-culture", "nz_culture_"],
    ["nz-environment", "nz_env_"],
    ["nz-geo", "nz_geo_"],
    ["nz-govt", "nz_govt_"],
    ["nz-markets", "nz_markets_"],
    ["nz-stats", "nz_stats_"],
    ["nz-transport", "nz_transport_"],
  ];

  it.each(REGISTERED_SERVERS)("routes /%s/mcp and its tools/list returns only that server's tools", async (slug, toolPrefix) => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/${slug}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-shared-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.0" },
          },
        }),
      }),
    );
    expect(response.status).not.toBe(401);
    const sessionId = response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const toolsResponse = await exports.default.fetch(
      new Request(`${ORIGIN}/${slug}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-shared-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId as string,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
    );
    expect(toolsResponse.status).not.toBe(401);
    const body = await toolsResponse.text();
    // Every tool name in this server's namespace starts with its own tool prefix — a leak from a
    // different server's tools would show up as a tool name not matching this prefix.
    const toolNameMatches = [...body.matchAll(/"name":"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(toolNameMatches.length).toBeGreaterThan(0);
    for (const name of toolNameMatches) {
      expect(name?.startsWith(toolPrefix)).toBe(true);
    }
  });

  it("404s an unregistered slug", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/does-not-exist/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer test-shared-token", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    // Not a registered apiHandler path or the OAuth provider's own routes: falls through to the
    // portal's Hono app (mounted as defaultHandler), whose own notFound handler renders a 404.
    expect(response.status).toBe(404);
  });
});
