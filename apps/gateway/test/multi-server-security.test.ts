import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __setAccessJwksResolverForTesting } from "@iolab/mcp-kit/access";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

// Security behaviour that only exists because one shared authorization server now covers every
// registered MCP server — see the gateway plan's findings A and B. Split from oauth.test.ts (which
// covers the OAuth flow mechanics, largely unchanged from the single-server design) because these
// tests are specifically about what changed by going multi-server.
const ORIGIN = "https://mcp.example.com";
const ACCESS_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ACCESS_AUD = "test-aud-tag";
const ACCESS_EMAIL = "operator@example.com";

function resourceFor(slug: string): string {
  return `${ORIGIN}/${slug}/mcp`;
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

async function pingMcp(slug: string, token: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`${ORIGIN}/${slug}/mcp`, {
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
}

describe("multi-server OAuth security", () => {
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

  /** Runs a full DCR-free authorize→token flow for `resource` against `client`, returning the access token. */
  async function getToken(client: RegisteredClient, resource: string | undefined): Promise<string> {
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
    if (resource !== undefined) authorizeUrl.searchParams.set("resource", resource);

    const consentResponse = await exports.default.fetch(
      new Request(authorizeUrl, { headers: { "Cf-Access-Jwt-Assertion": accessJwt } }),
    );
    if (consentResponse.status !== 200) {
      throw new Error(`consent page returned ${consentResponse.status}: ${await consentResponse.text()}`);
    }
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
    const body = (await tokenResponse.json()) as { access_token?: string };
    if (!body.access_token) throw new Error(`token endpoint returned no access_token: ${JSON.stringify(body)}`);
    return body.access_token;
  }

  /** Runs GET+POST /authorize (no completed token exchange) and returns the POST response, for
   * asserting the rejection itself rather than needing a successful grant. */
  async function attemptAuthorize(
    client: RegisteredClient,
    resourceParams: string[] | undefined,
  ): Promise<Response> {
    const [redirectUri] = client.redirect_uris;
    if (!redirectUri) throw new Error("registration response missing redirect_uris");

    const accessJwt = await signAccessJwt();
    const authorizeUrl = new URL(`${ORIGIN}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", crypto.randomUUID());
    authorizeUrl.searchParams.set("code_challenge", await base64UrlSha256(`verifier-${crypto.randomUUID()}`));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    for (const resource of resourceParams ?? []) authorizeUrl.searchParams.append("resource", resource);

    // GET is where enforcement runs first; a rejection there never reaches POST at all in real
    // usage, but exercising GET directly is what proves the rejection, since the consent page
    // itself is what a client is blocked from ever seeing.
    return exports.default.fetch(new Request(authorizeUrl, { headers: { "Cf-Access-Jwt-Assertion": accessJwt } }));
  }

  describe("cross-path audience isolation (finding B)", () => {
    it("a token minted for /nz-govt/mcp is rejected at /nz-geo/mcp but accepted at /nz-govt/mcp", async () => {
      const client = await registerClient();
      const token = await getToken(client, resourceFor("nz-govt"));

      const wrongPathResponse = await pingMcp("nz-geo", token);
      expect(wrongPathResponse.status).toBe(401);
      expect(wrongPathResponse.headers.get("www-authenticate")).toContain("Invalid audience");

      const rightPathResponse = await pingMcp("nz-govt", token);
      expect(rightPathResponse.status).not.toBe(401);
    });

    it("PINNED: with enforcement disabled, a token issued without a resource parameter is NOT audience-restricted — usable at every registered path", async () => {
      // Pins the library's own underlying behaviour (packages/mcp-kit/src/oauth.ts's docstring on
      // `validateResourceForRegisteredPath`): `handleApiRequest` only checks a token's audience
      // when the token *has* one. Our own enforcement closes this in the default configuration —
      // see the "per-path resource enforcement" describe block below — but this test proves the
      // residual gap the DISABLE_RESOURCE_ENFORCEMENT escape hatch reopens is exactly what its
      // docstring says it is, so a future library upgrade can't silently change it unnoticed.
      // `env` (from `cloudflare:workers`) is typed as `Cloudflare.Env`, which only carries the
      // wrangler.jsonc-declared bindings — not the hand-typed secrets augmenting the global `Env`
      // in src/env.d.ts. Cast for this one mutable-config test rather than widening that type for
      // every other consumer of `cloudflare:workers`'s `env`.
      const mutableEnv = env as unknown as Env;
      const original = mutableEnv.DISABLE_RESOURCE_ENFORCEMENT;
      mutableEnv.DISABLE_RESOURCE_ENFORCEMENT = "true";
      try {
        const client = await registerClient();
        const token = await getToken(client, undefined);

        expect((await pingMcp("nz-govt", token)).status).not.toBe(401);
        expect((await pingMcp("nz-geo", token)).status).not.toBe(401);
        expect((await pingMcp("nz-markets", token)).status).not.toBe(401);
      } finally {
        if (original === undefined) delete mutableEnv.DISABLE_RESOURCE_ENFORCEMENT;
        else mutableEnv.DISABLE_RESOURCE_ENFORCEMENT = original;
      }
    });
  });

  describe("per-path resource enforcement at /authorize (finding B)", () => {
    it("rejects a missing resource parameter", async () => {
      const client = await registerClient();
      const response = await attemptAuthorize(client, undefined);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("missing 'resource' parameter");
    });

    it("rejects multiple resource parameters", async () => {
      const client = await registerClient();
      const response = await attemptAuthorize(client, [resourceFor("nz-govt"), resourceFor("nz-geo")]);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("multiple 'resource' parameters");
    });

    it("rejects a cross-origin resource", async () => {
      const client = await registerClient();
      const response = await attemptAuthorize(client, ["https://attacker.example.com/nz-govt/mcp"]);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("does not match this server");
    });

    it("rejects an origin-only resource (no path)", async () => {
      const client = await registerClient();
      const response = await attemptAuthorize(client, [ORIGIN]);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("origin-only");
    });

    it("rejects a resource path that isn't a registered server", async () => {
      const client = await registerClient();
      const response = await attemptAuthorize(client, [`${ORIGIN}/not-a-real-server/mcp`]);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("is not a registered MCP server");
    });

    it("accepts a resource exactly matching a registered server path", async () => {
      const client = await registerClient();
      const response = await attemptAuthorize(client, [resourceFor("nz-geo")]);
      expect(response.status).toBe(200);
    });
  });

  describe("revokeExistingGrants: false (finding A)", () => {
    it("authorizing the same client_id for a second resource does not revoke the first resource's grant", async () => {
      const client = await registerClient();

      const firstToken = await getToken(client, resourceFor("nz-govt"));
      expect((await pingMcp("nz-govt", firstToken)).status).not.toBe(401);

      // Same client_id, different resource — exactly the "connector switching resource" scenario
      // finding A describes. Without `revokeExistingGrants: false` in completeAuthorization, this
      // second grant would revoke the first one by default (same userId + same clientId).
      const secondToken = await getToken(client, resourceFor("nz-geo"));
      expect((await pingMcp("nz-geo", secondToken)).status).not.toBe(401);

      // The regression this test exists to catch: the FIRST token must still work.
      expect((await pingMcp("nz-govt", firstToken)).status).not.toBe(401);
    });
  });
});
