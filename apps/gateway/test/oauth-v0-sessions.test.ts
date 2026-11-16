import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
// The exact library version production ran before the 1.x upgrade, installed under an alias so both
// versions load side by side. It writes clients, grants and tokens into the same OAUTH_KV the gateway
// reads, which is what a deploy of the upgrade meets in production.
import { OAuthProvider as OAuthProviderV0 } from "workers-oauth-provider-v0";
import { SERVERS } from "../src/servers.js";

const ORIGIN = "https://mcp.example.com";

function resourceFor(slug: string): string {
  return `${ORIGIN}/${slug}/mcp`;
}

const unusedHandler = { fetch: () => new Response("unused", { status: 500 }) };

/**
 * The 0.10.4 provider as production configured it: one `OAuthProvider`, an `apiHandlers` entry per
 * `/{slug}/mcp`, and `allowPlainPKCE: false`. Only its storage matters here, so the handlers are stubs.
 */
const v0Provider = new OAuthProviderV0<Env>({
  apiHandlers: Object.fromEntries(SERVERS.map((s) => [`/${s.slug}/mcp`, unusedHandler])),
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  allowPlainPKCE: false,
  defaultHandler: {
    // Stands in for the old consent page: grants straight away, the way POST /authorize did.
    async fetch(request: Request, handlerEnv: Env) {
      const helpers = handlerEnv.OAUTH_PROVIDER;
      if (!helpers) throw new Error("0.10.4 did not inject OAUTH_PROVIDER");
      const authRequest = await helpers.parseAuthRequest(request);
      const { redirectTo } = await helpers.completeAuthorization({
        request: authRequest,
        userId: "operator@example.com",
        scope: authRequest.scope,
        metadata: { label: "operator@example.com" },
        props: { email: "operator@example.com" },
        revokeExistingGrants: false,
      });
      return Response.redirect(redirectTo, 302);
    },
  },
});

// Typed loosely: the v0 package's types expect its own ExecutionContext shape, and the context is
// never used by the paths these tests take (registration, authorize, token).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as any;

function v0Fetch(request: Request): Promise<Response> {
  return v0Provider.fetch(request, env as unknown as Env, ctx);
}

async function base64UrlSha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface V0Session {
  clientId: string;
  clientSecret: string | undefined;
  accessToken: string;
  refreshToken: string;
}

/**
 * Registers a client, authorizes `resource` and exchanges the code, all on 0.10.4. `confidential`
 * mirrors claude.ai's registration (client_secret_post); otherwise a public client like Cursor.
 */
async function createV0Session(resource: string, confidential: boolean): Promise<V0Session> {
  const redirectUri = confidential ? "https://claude.ai/api/mcp/auth_callback" : "https://www.cursor.com/callback";
  const registration = await v0Fetch(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
        grant_types: ["authorization_code", "refresh_token"],
      }),
    }),
  );
  expect(registration.status).toBe(201);
  const client = (await registration.json()) as { client_id: string; client_secret?: string };

  const verifier = `v0-verifier-${crypto.randomUUID()}`;
  const authorizeUrl = new URL(`${ORIGIN}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", "s");
  authorizeUrl.searchParams.set("code_challenge", await base64UrlSha256(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("resource", resource);
  const authorized = await v0Fetch(new Request(authorizeUrl, { redirect: "manual" }));
  expect(authorized.status).toBe(302);
  const code = new URL(authorized.headers.get("location") as string).searchParams.get("code") as string;

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource,
  });
  if (client.client_secret) tokenBody.set("client_secret", client.client_secret);
  const tokenResponse = await v0Fetch(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    }),
  );
  expect(tokenResponse.status).toBe(200);
  const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };
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
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      }),
    }),
  );
}

async function refreshOnGateway(session: V0Session, resource: string | undefined): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
  });
  if (resource !== undefined) body.set("resource", resource);
  if (session.clientSecret) body.set("client_secret", session.clientSecret);
  return exports.default.fetch(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
}

// Existing connectors must keep working across the upgrade: these are sessions created by the
// library version production ran before (0.10.4), then used against the gateway as it is now.
describe("sessions created by workers-oauth-provider 0.10.4", () => {
  for (const confidential of [true, false]) {
    const kind = confidential ? "confidential client (claude.ai)" : "public client (Cursor)";

    it(`${kind}: the old access token still works on its own server and nowhere else`, async () => {
      const session = await createV0Session(resourceFor("nz-govt"), confidential);
      expect((await pingMcp("nz-govt", session.accessToken)).status).not.toBe(401);
      expect((await pingMcp("nz-geo", session.accessToken)).status).toBe(401);
      expect((await pingMcp("wikimedia", session.accessToken)).status).toBe(401);
    });

    it(`${kind}: the old refresh token refreshes, naming its resource, and the new token stays on its server`, async () => {
      const session = await createV0Session(resourceFor("ia"), confidential);
      const response = await refreshOnGateway(session, resourceFor("ia"));
      expect(response.status).toBe(200);
      const tokens = (await response.json()) as { access_token: string };
      expect((await pingMcp("ia", tokens.access_token)).status).not.toBe(401);
      expect((await pingMcp("nz-stats", tokens.access_token)).status).toBe(401);
    });

    it(`${kind}: the old refresh token refreshes without naming a resource`, async () => {
      const session = await createV0Session(resourceFor("nz-markets"), confidential);
      const response = await refreshOnGateway(session, undefined);
      expect(response.status).toBe(200);
      const tokens = (await response.json()) as { access_token: string };
      expect((await pingMcp("nz-markets", tokens.access_token)).status).not.toBe(401);
    });
  }

  it("an old refresh token cannot be moved onto another server", async () => {
    const session = await createV0Session(resourceFor("nz-culture"), true);
    const response = await refreshOnGateway(session, resourceFor("nz-transport"));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { access_token?: string }).access_token).toBeUndefined();
  });
});
