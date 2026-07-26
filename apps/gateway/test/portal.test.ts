import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __setAccessJwksResolverForTesting } from "@iolab/mcp-kit/access";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

// packages/credentials/schema.sql — miniflare's local D1 simulation starts empty, unlike a real
// deployed D1 database (which docs/SETUP.md has the operator apply this against once via
// `wrangler d1 execute`). Every other package's D1 tests use an in-memory fake instead of a real
// binding, so this is the first place in the repo that needs the real schema applied for tests.
const CREDENTIALS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS credentials (
    server TEXT NOT NULL,
    key_name TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (server, key_name)
  );
`;

// The portal itself has a thorough unit-level test suite (apps/portal/test/**) exercising its Hono
// app directly via `.request()`. These are lighter integration checks that the mount actually works
// through the REAL composed fetch handler — OAuthProvider's defaultHandler routing, not a shortcut —
// since that's the one thing the portal's own tests can't see.
const ORIGIN = "https://mcp.example.com";
const ACCESS_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ACCESS_AUD = "test-aud-tag";
const ACCESS_EMAIL = "operator@example.com";

describe("portal mounted in the gateway", () => {
  let signAccessJwt: () => Promise<string>;

  beforeAll(async () => {
    await env.CREDENTIALS_DB.prepare(CREDENTIALS_SCHEMA).run();

    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] });
    __setAccessJwksResolverForTesting(() => jwks);

    signAccessJwt = () =>
      new SignJWT({ email: ACCESS_EMAIL })
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

  it("serves the public landing page at / with no Access JWT", async () => {
    const response = await exports.default.fetch(new Request(ORIGIN));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("iolab MCP fleet");
  });

  it("403s /admin with no Access JWT", async () => {
    const response = await exports.default.fetch(new Request(`${ORIGIN}/admin`));
    expect(response.status).toBe(403);
  });

  it("200s /admin with a valid Access JWT and lists the registered servers", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/admin`, { headers: { "Cf-Access-Jwt-Assertion": await signAccessJwt() } }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("nz-govt-mcp");
  });

  it("does not shadow the OAuth provider's own routes: /token stays public and portal-unaware", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: "bogus" }),
      }),
    );
    // Reaches the OAuth provider's token endpoint (which rejects the bogus code), not the portal's
    // 404 page — proves apiHandlers/well-known/token/register routing takes priority over the
    // portal defaultHandler mount, exactly as buildMultiServerOAuthWorker intends.
    expect(response.status).not.toBe(404);
  });
});
