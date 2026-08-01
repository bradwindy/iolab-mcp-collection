import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptValue } from "@iolab/credentials";
import { getAccessToken } from "../src/auth.js";
import { openSession, redditGet } from "../src/clients/http.js";
import { InvalidCredentialsError, MissingCredentialError, requireRedditCredentials } from "../src/credentials.js";
import {
  calledHeaders,
  calledUrls,
  fakeEnv,
  isOauthHost,
  isTokenRequest,
  stubFetchRoutes,
  TEST_ENCRYPTION_KEY,
  tokenRoute,
} from "./support/fakeEnv.js";

const dataRoute = (overrides: Parameters<typeof stubFetchRoutes>[0][number]["sequence"] = undefined) =>
  overrides ? { match: isOauthHost, sequence: overrides } : { match: isOauthHost, body: { ok: true } };

describe("reddit access token", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mints once and reuses the cached token across calls", async () => {
    const mock = stubFetchRoutes([tokenRoute(), dataRoute()]);
    const env = await fakeEnv();
    const session = await openSession(env);

    await redditGet(session, env, "/r/newzealand/hot");
    await redditGet(session, env, "/r/newzealand/new");

    const tokenCalls = calledUrls(mock).filter((url) => isTokenRequest(url.toString()));
    expect(tokenCalls).toHaveLength(1);
  });

  it("sends the client credentials as HTTP Basic and asks for the client_credentials grant", async () => {
    const mock = stubFetchRoutes([tokenRoute(), dataRoute()]);
    const env = await fakeEnv();

    await getAccessToken(env, await requireRedditCredentials(env));

    const headers = calledHeaders(mock, 0);
    expect(headers.get("Authorization")).toBe(`Basic ${btoa("test-client-id:test-client-secret")}`);
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    const init = mock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("grant_type=client_credentials");
  });

  it("expires the cache entry ahead of the token so a long tool call cannot straddle the boundary", async () => {
    stubFetchRoutes([tokenRoute({ expiresIn: 3600 })]);
    const env = await fakeEnv();

    await getAccessToken(env, await requireRedditCredentials(env));

    const written = env.MCP_CACHE.puts.at(-1);
    expect(written?.ttl).toBe(3600 - 300);
    expect(written?.key.startsWith("reddit:token:")).toBe(true);
  });

  it("never writes a TTL below KV's 60-second floor, even for an absurdly short token", async () => {
    stubFetchRoutes([tokenRoute({ expiresIn: 30 })]);
    const env = await fakeEnv();

    await getAccessToken(env, await requireRedditCredentials(env));

    expect(env.MCP_CACHE.puts.at(-1)?.ttl).toBe(60);
  });

  it("treats a cached entry whose recorded expiry has passed as a miss, even if KV still returns it", async () => {
    stubFetchRoutes([tokenRoute({ token: "fresh-token" })]);
    const env = await fakeEnv();
    const creds = await requireRedditCredentials(env);

    // Simulate KV's eventual consistency handing back a value it should already have dropped.
    const key = env.MCP_CACHE.puts.at(-1)?.key ?? (await getAccessToken(env, creds), env.MCP_CACHE.puts.at(-1)!.key);
    env.MCP_CACHE.store.set(key, JSON.stringify({ token: "stale-token", expiresAtMs: Date.now() - 1000 }));

    expect(await getAccessToken(env, creds)).toBe("fresh-token");
  });

  it("treats a corrupted cache entry as a miss rather than throwing", async () => {
    stubFetchRoutes([tokenRoute({ token: "fresh-token" })]);
    const env = await fakeEnv();
    const creds = await requireRedditCredentials(env);
    await getAccessToken(env, creds);

    const key = env.MCP_CACHE.puts.at(-1)!.key;
    env.MCP_CACHE.store.set(key, "not json at all");

    expect(await getAccessToken(env, creds)).toBe("fresh-token");
  });

  it("falls back to an hour when Reddit omits or reports a nonsense expires_in", async () => {
    stubFetchRoutes([{ match: isTokenRequest, body: { access_token: "t", token_type: "bearer" } }]);
    const env = await fakeEnv();

    await getAccessToken(env, await requireRedditCredentials(env));

    expect(env.MCP_CACHE.puts.at(-1)?.ttl).toBe(3300);
  });

  it("re-mints exactly once when a data request 401s, then retries it", async () => {
    const mock = stubFetchRoutes([
      tokenRoute(),
      { match: isOauthHost, sequence: [{ status: 401, body: {} }, { status: 200, body: { ok: true } }] },
    ]);
    const env = await fakeEnv();
    const session = await openSession(env);

    const result = await redditGet<{ ok: boolean }>(session, env, "/r/newzealand/hot");

    expect(result.ok).toBe(true);
    const urls = calledUrls(mock);
    expect(urls.filter((url) => isTokenRequest(url.toString()))).toHaveLength(2);
    expect(urls.filter((url) => url.hostname === "oauth.reddit.com")).toHaveLength(2);
  });

  it("does not loop when the retry also 401s — one re-mint, then the error surfaces", async () => {
    const mock = stubFetchRoutes([tokenRoute(), { match: isOauthHost, status: 401, body: {} }]);
    const env = await fakeEnv();
    const session = await openSession(env);

    await expect(redditGet(session, env, "/r/newzealand/hot")).rejects.toThrow();

    const urls = calledUrls(mock);
    expect(urls.filter((url) => isTokenRequest(url.toString()))).toHaveLength(2);
    expect(urls.filter((url) => url.hostname === "oauth.reddit.com")).toHaveLength(2);
  });

  it("raises InvalidCredentialsError — not a transient upstream error — when the mint itself is rejected", async () => {
    stubFetchRoutes([{ match: isTokenRequest, status: 401, body: { error: "invalid_grant" } }]);
    const env = await fakeEnv();

    await expect(getAccessToken(env, await requireRedditCredentials(env))).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("also treats a 403 from the mint as bad credentials — that is what a wrong app type returns", async () => {
    stubFetchRoutes([{ match: isTokenRequest, status: 403, body: {} }]);
    const env = await fakeEnv();

    await expect(getAccessToken(env, await requireRedditCredentials(env))).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("rejects a token response that carries no access_token", async () => {
    stubFetchRoutes([{ match: isTokenRequest, body: { token_type: "bearer", expires_in: 3600 } }]);
    const env = await fakeEnv();

    await expect(getAccessToken(env, await requireRedditCredentials(env))).rejects.toThrow(/no access_token/);
  });

  it("lets two concurrent cold-cache callers both succeed rather than deadlocking on a lock", async () => {
    stubFetchRoutes([tokenRoute(), dataRoute()]);
    const env = await fakeEnv();
    const session = await openSession(env);

    const [a, b] = await Promise.all([redditGet(session, env, "/a"), redditGet(session, env, "/b")]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
  });

  it("encrypts the cached token at rest, the same way the client secret is protected in D1", async () => {
    stubFetchRoutes([tokenRoute({ token: "super-secret-token" })]);
    const env = await fakeEnv();

    await getAccessToken(env, await requireRedditCredentials(env));

    const stored = env.MCP_CACHE.store.get(env.MCP_CACHE.puts.at(-1)!.key)!;
    // Read access to the shared KV namespace alone must not yield a usable bearer token.
    expect(stored).not.toContain("super-secret-token");
    const decrypted = JSON.parse(await decryptValue(stored, TEST_ENCRYPTION_KEY)) as { token: string };
    expect(decrypted.token).toBe("super-secret-token");
  });

  it("never records an expiry beyond the token's real lifetime, even when KV's TTL floor applies", async () => {
    stubFetchRoutes([tokenRoute({ expiresIn: 30 })]);
    const env = await fakeEnv();
    const before = Date.now();

    await getAccessToken(env, await requireRedditCredentials(env));

    // The TTL is clamped up to KV's 60s floor, but the recorded expiry must still track the real
    // 30s token — otherwise a dead token is served until the 401 path rescues it.
    const stored = env.MCP_CACHE.store.get(env.MCP_CACHE.puts.at(-1)!.key)!;
    const { expiresAtMs } = JSON.parse(await decryptValue(stored, TEST_ENCRYPTION_KEY)) as { expiresAtMs: number };
    expect(expiresAtMs).toBeLessThanOrEqual(before + 30_000 + 50);
  });

  it("retries a rate-limited token endpoint rather than hard-failing every tool", async () => {
    const mock = stubFetchRoutes([
      {
        match: isTokenRequest,
        sequence: [
          { status: 429, body: {}, headers: { "retry-after": "0" } },
          { status: 200, body: { access_token: "recovered", token_type: "bearer", expires_in: 3600 } },
        ],
      },
    ]);
    const env = await fakeEnv();

    await expect(getAccessToken(env, await requireRedditCredentials(env))).resolves.toBe("recovered");
    expect(calledUrls(mock).filter((url) => isTokenRequest(url.toString()))).toHaveLength(2);
  });

  it("does not retry a rejected credential, which would only burn the login quota", async () => {
    const mock = stubFetchRoutes([{ match: isTokenRequest, status: 401, body: {} }]);
    const env = await fakeEnv();

    await expect(getAccessToken(env, await requireRedditCredentials(env))).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(calledUrls(mock)).toHaveLength(1);
  });

  it("reports a non-ASCII credential as a credentials problem, not an opaque encoding error", async () => {
    // btoa throws on any code point above U+00FF — a mis-pasted smart quote, typically.
    stubFetchRoutes([tokenRoute()]);
    const env = await fakeEnv({ clientSecret: "secret’with-smart-quote" });

    await expect(getAccessToken(env, await requireRedditCredentials(env))).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("keys the token cache on a hash, never on the client id in the clear", async () => {
    stubFetchRoutes([tokenRoute()]);
    const env = await fakeEnv();

    await getAccessToken(env, await requireRedditCredentials(env));

    const key = env.MCP_CACHE.puts.at(-1)!.key;
    expect(key).not.toContain("test-client-id");
    expect(key).toMatch(/^reddit:token:[0-9a-f]{32}$/);
  });
});

describe("required credentials", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["REDDIT_CLIENT_ID", { clientId: null }],
    ["REDDIT_CLIENT_SECRET", { clientSecret: null }],
    ["REDDIT_USERNAME", { username: null }],
  ] as const)("names %s when it is the one that has not been set", async (keyName, opts) => {
    const env = await fakeEnv(opts);

    await expect(requireRedditCredentials(env)).rejects.toMatchObject({
      name: "MissingCredentialError",
      keyName,
    });
  });

  it("reports the first missing key in a stable order so the portal form can be filled top-down", async () => {
    const env = await fakeEnv({ clientId: null, clientSecret: null, username: null });

    await expect(requireRedditCredentials(env)).rejects.toBeInstanceOf(MissingCredentialError);
    await expect(requireRedditCredentials(env)).rejects.toMatchObject({ keyName: "REDDIT_CLIENT_ID" });
  });

  it("returns all three when they are set", async () => {
    const env = await fakeEnv();

    await expect(requireRedditCredentials(env)).resolves.toEqual({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      username: "testuser",
    });
  });
});
