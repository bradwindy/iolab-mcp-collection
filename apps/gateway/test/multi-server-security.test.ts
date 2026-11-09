import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePkceS256 } from "@iolab/mcp-kit";
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

/** Reads the client redirect URL (code + state) from POST /authorize's 200 hand-off page. */
async function extractRedirectUrl(response: Response): Promise<URL> {
  expect(response.status).toBe(200);
  const html = await response.text();
  const href = /<a id="continue" href="([^"]+)"/.exec(html)?.[1];
  if (!href) throw new Error("hand-off page missing continue link");
  return new URL(href.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
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
    const code = (await extractRedirectUrl(authorizeResponse)).searchParams.get("code");

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

    it("accepts the wikimedia slug, proving a newly registered server joins the audience allowlist", async () => {
      // The allowlist is derived from SERVERS, so a server that is registered but somehow not
      // routed would fail here rather than silently 400ing every OAuth authorization for it.
      const client = await registerClient();
      const response = await attemptAuthorize(client, [resourceFor("wikimedia")]);
      expect(response.status).toBe(200);
    });
  });

  describe("PKCE S256 enforcement at /authorize", () => {
    // These pin that no non-S256 PKCE shape gets a grant. Since workers-oauth-provider 0.10 the library
    // rejects every non-S256 method itself, and a missing challenge for public clients; validatePkceS256
    // covers a confidential client with no PKCE at all.
    async function authorizeWithPkce(
      challenge: string | null,
      method: string | null,
      clientBody: Record<string, unknown> = {},
    ): Promise<Response> {
      const client = await registerClient(clientBody);
      const [redirectUri] = client.redirect_uris;
      const authorizeUrl = new URL(`${ORIGIN}/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri!);
      authorizeUrl.searchParams.set("state", crypto.randomUUID());
      authorizeUrl.searchParams.set("resource", resourceFor("nz-govt"));
      if (challenge !== null) authorizeUrl.searchParams.set("code_challenge", challenge);
      if (method !== null) authorizeUrl.searchParams.set("code_challenge_method", method);
      return exports.default.fetch(
        new Request(authorizeUrl, { headers: { "Cf-Access-Jwt-Assertion": await signAccessJwt() } }),
      );
    }

    it("rejects code_challenge_method=S256 with no code_challenge", async () => {
      const response = await authorizeWithPkce(null, "S256");
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("code_challenge");
    });

    it("rejects a request with neither PKCE parameter", async () => {
      const response = await authorizeWithPkce(null, null);
      expect(response.status).toBe(400);
    });

    // Since workers-oauth-provider 0.10, parseAuthRequest itself rejects any method other than
    // "plain"/"S256", so this reaches the client as the library's message rather than ours.
    it("rejects code_challenge_method=PLAIN", async () => {
      const response = await authorizeWithPkce("a-plain-challenge-value-that-is-long-enough-43c", "PLAIN");
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Unsupported PKCE code_challenge_method");
    });

    it("rejects code_challenge_method=plain", async () => {
      const response = await authorizeWithPkce("a-plain-challenge-value-that-is-long-enough-43c", "plain");
      expect(response.status).toBe(400);
    });

    // The library only rejects a missing challenge for public clients, so a confidential client with
    // no PKCE is stopped by validatePkceS256 alone. This pins that the handler still calls it.
    it("rejects a confidential client with neither PKCE parameter", async () => {
      const response = await authorizeWithPkce(null, null, { token_endpoint_auth_method: "client_secret_basic" });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("PKCE with S256 is required");
    });

    it("rejects a confidential client that drops PKCE between the consent page and POST /authorize", async () => {
      const client = await registerClient({ token_endpoint_auth_method: "client_secret_basic" });
      const [redirectUri] = client.redirect_uris;
      if (!redirectUri) throw new Error("registration response missing redirect_uris");
      const accessJwt = await signAccessJwt();
      const authorizeUrl = new URL(`${ORIGIN}/authorize`);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("state", crypto.randomUUID());
      authorizeUrl.searchParams.set("resource", resourceFor("nz-govt"));
      authorizeUrl.searchParams.set("code_challenge", await base64UrlSha256("pkce-dropped-verifier-1234567890"));
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      const consentResponse = await exports.default.fetch(
        new Request(authorizeUrl, { headers: { "Cf-Access-Jwt-Assertion": accessJwt } }),
      );
      expect(consentResponse.status).toBe(200);
      const csrfToken = extractCsrfToken(consentResponse);

      const approveBody = new URLSearchParams(authorizeUrl.searchParams);
      approveBody.delete("code_challenge");
      approveBody.delete("code_challenge_method");
      approveBody.set("csrf_token", csrfToken);
      const response = await exports.default.fetch(
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
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("PKCE with S256 is required");
    });

    // The test client is public, so the library rejects the bad requests above before our own check
    // runs and the end-to-end tests no longer prove validatePkceS256 works. Test it directly.
    it("validatePkceS256 accepts only an S256 method with a challenge", () => {
      expect(validatePkceS256("challenge", "S256")).toEqual({ ok: true });
      expect(validatePkceS256(undefined, "S256").ok).toBe(false);
      expect(validatePkceS256("", "S256").ok).toBe(false);
      expect(validatePkceS256("challenge", "PLAIN").ok).toBe(false);
      expect(validatePkceS256("challenge", "plain").ok).toBe(false);
      expect(validatePkceS256("challenge", "s256").ok).toBe(false);
      expect(validatePkceS256("challenge", undefined).ok).toBe(false);
    });

    it("accepts an S256 challenge", async () => {
      const response = await authorizeWithPkce(await base64UrlSha256("pkce-ok-verifier-1234567890"), "S256");
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
