import { exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __setAccessJwksResolverForTesting } from "@nz-mcp/mcp-kit";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

const ORIGIN = "https://nz-culture.mcp.example.com";
const ACCESS_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ACCESS_AUD = "test-aud-tag";
const ACCESS_EMAIL = "operator@example.com";

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

async function registerClient(body: Record<string, unknown>): Promise<RegisteredClient> {
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

describe("OAuth (buildOAuthMcpWorker)", () => {
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

  it("returns 401 with a resource_metadata WWW-Authenticate challenge for an unauthenticated /mcp request", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain("resource_metadata=");
  });

  it("serves RFC 8414 authorization server metadata advertising S256-only PKCE", async () => {
    const response = await exports.default.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as AuthorizationServerMetadata;
    expect(metadata.authorization_endpoint).toContain("/authorize");
    expect(metadata.token_endpoint).toContain("/token");
    expect(metadata.registration_endpoint).toContain("/register");
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("serves RFC 9728 protected resource metadata for /mcp with a matching resource URL", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
    );
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as ProtectedResourceMetadata;
    expect(metadata.resource).toBe(`${ORIGIN}/mcp`);
    expect(metadata.authorization_servers?.length).toBeGreaterThan(0);
  });

  it("rejects /authorize with no Access JWT", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/authorize?response_type=code&client_id=x&redirect_uri=https://client.example.com/cb`),
    );
    expect(response.status).toBe(403);
  });

  it("rejects /authorize with an Access JWT for the wrong email", async () => {
    const wrongEmailJwt = await signAccessJwt({ email: "someone-else@example.com" });
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/authorize?response_type=code&client_id=x&redirect_uri=https://client.example.com/cb`, {
        headers: { "Cf-Access-Jwt-Assertion": wrongEmailJwt },
      }),
    );
    expect(response.status).toBe(403);
  });

  it("renders a consent page for GET /authorize, escaping an attacker-controlled client name", async () => {
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
  });

  it("doesn't let a crafted csrf_token query param shadow the real one on the consent page", async () => {
    const client = await registerClient({});
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
    // An attacker-crafted link could itself carry a csrf_token param, trying to pre-fill the hidden
    // field the operator is about to submit.
    authorizeUrl.searchParams.set("csrf_token", "attacker-supplied-value");

    const consentResponse = await exports.default.fetch(
      new Request(authorizeUrl, { headers: { "Cf-Access-Jwt-Assertion": accessJwt } }),
    );
    expect(consentResponse.status).toBe(200);
    const html = await consentResponse.text();
    expect(html).not.toContain("attacker-supplied-value");
    // Exactly one csrf_token hidden field: the one matching the freshly minted cookie.
    expect(html.match(/name="csrf_token"/g)).toHaveLength(1);
    expect(html).toContain(`value="${extractCsrfToken(consentResponse)}"`);
  });

  it("rejects POST /authorize with a missing or mismatched CSRF token", async () => {
    const accessJwt = await signAccessJwt();
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": accessJwt },
        body: new URLSearchParams({
          response_type: "code",
          client_id: "does-not-matter",
          redirect_uri: "https://client.example.com/callback",
          csrf_token: "attacker-guessed-token",
        }),
        // No matching __Host-OAUTH_CSRF cookie: this is what a forged cross-site POST would look like.
      }),
    );
    expect(response.status).toBe(403);
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
          csrf_token: "irrelevant-since-identity-is-checked-first",
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects GET /authorize for an unregistered client_id", async () => {
    const accessJwt = await signAccessJwt();
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/authorize?response_type=code&client_id=does-not-exist&redirect_uri=https://client.example.com/cb`, {
        headers: { "Cf-Access-Jwt-Assertion": accessJwt },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("completes the authorization flow end-to-end via the consent page for a valid Access identity", async () => {
    // 1. Dynamic Client Registration, exactly as claude.ai would perform it.
    const client = await registerClient({});
    const [redirectUri] = client.redirect_uris;
    if (!redirectUri) throw new Error("registration response missing redirect_uris");

    // 2. PKCE S256 challenge for the /authorize request.
    const codeVerifier = "test-code-verifier-with-enough-entropy-1234567890";
    const codeChallenge = await base64UrlSha256(codeVerifier);

    // 3. GET /authorize behind a (simulated) already-authenticated Cloudflare Access request — this
    // renders the consent page, it does not grant anything yet.
    const accessJwt = await signAccessJwt();
    const authorizeUrl = new URL(`${ORIGIN}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", "xyz-state");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const consentResponse = await exports.default.fetch(
      new Request(authorizeUrl, { headers: { "Cf-Access-Jwt-Assertion": accessJwt } }),
    );
    expect(consentResponse.status).toBe(200);
    const csrfToken = extractCsrfToken(consentResponse);

    // 4. POST — the consent form's own submit — completes the grant.
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
    const location = authorizeResponse.headers.get("location");
    expect(location).not.toBeNull();
    const redirectUrl = new URL(location as string);
    expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(redirectUri);
    const code = redirectUrl.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get("state")).toBe("xyz-state");

    // 5. PKCE is only meaningful if /token actually enforces it: a mismatched verifier must be
    // rejected, and — since a rejection must not consume the code (RFC 6749 §4.1.2, clients need to
    // be able to retry) — the matching verifier must still redeem the same code afterwards.
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
    const tokenBody = (await tokenResponse.json()) as { access_token?: string };
    expect(tokenBody.access_token).toBeTruthy();
  });
});
