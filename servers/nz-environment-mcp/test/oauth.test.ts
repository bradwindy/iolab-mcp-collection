import { exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __setAccessJwksResolverForTesting } from "@nz-mcp/mcp-kit";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

const ORIGIN = "https://nz-environment.mcp.example.com";
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

  it("completes the authorization flow end-to-end for a valid Access identity", async () => {
    // 1. Dynamic Client Registration, exactly as claude.ai would perform it.
    const registerResponse = await exports.default.fetch(
      new Request(`${ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(registerResponse.status).toBe(201);
    const client = (await registerResponse.json()) as RegisteredClient;
    const [redirectUri] = client.redirect_uris;
    if (!redirectUri) throw new Error("registration response missing redirect_uris");

    // 2. PKCE S256 challenge for the /authorize request.
    const codeVerifier = "test-code-verifier-with-enough-entropy-1234567890";
    const codeChallenge = await base64UrlSha256(codeVerifier);

    // 3. GET /authorize behind a (simulated) already-authenticated Cloudflare Access request.
    const accessJwt = await signAccessJwt();
    const authorizeUrl = new URL(`${ORIGIN}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", "xyz-state");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeResponse = await exports.default.fetch(
      new Request(authorizeUrl, {
        headers: { "Cf-Access-Jwt-Assertion": accessJwt },
        redirect: "manual",
      }),
    );
    expect(authorizeResponse.status).toBe(302);
    const location = authorizeResponse.headers.get("location");
    expect(location).not.toBeNull();
    const redirectUrl = new URL(location as string);
    expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(redirectUri);
    expect(redirectUrl.searchParams.get("code")).toBeTruthy();
    expect(redirectUrl.searchParams.get("state")).toBe("xyz-state");
  });
});
