import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstreamHttpError } from "@iolab/mcp-kit";
import { ForbiddenContentError, openSession, redditGet, serially } from "../src/clients/http.js";
import { normaliseUsername, userAgent } from "../src/userAgent.js";
import { calledHeaders, calledUrls, dataUrls, fakeEnv, isOauthHost, isTokenRequest, stubFetchRoutes, tokenRoute } from "./support/fakeEnv.js";

describe("reddit HTTP client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends data requests to oauth.reddit.com, never to www.reddit.com", async () => {
    const mock = stubFetchRoutes([tokenRoute(), { match: isOauthHost, body: {} }]);
    const env = await fakeEnv();

    await redditGet(await openSession(env), env, "/r/newzealand/hot");

    const nonToken = calledUrls(mock).filter((url) => !isTokenRequest(url.toString()));
    expect(nonToken).toHaveLength(1);
    expect(nonToken[0]?.hostname).toBe("oauth.reddit.com");
  });

  it("carries the bearer token and Reddit's mandated User-Agent format on every data request", async () => {
    const mock = stubFetchRoutes([tokenRoute({ token: "abc123" }), { match: isOauthHost, body: {} }]);
    const env = await fakeEnv({ username: "bradley" });

    await redditGet(await openSession(env), env, "/r/newzealand/hot");

    const headers = calledHeaders(mock, 1);
    expect(headers.get("Authorization")).toBe("Bearer abc123");
    // <platform>:<app id>:<version> (by /u/<username>) — a generic User-Agent is throttled or
    // blocked outright by Reddit's own documented rules.
    expect(headers.get("User-Agent")).toBe("cloudflare-workers:iolab-reddit-mcp:v0.1.0 (by /u/bradley)");
  });

  it("forces raw_json=1 on every request, and a caller cannot turn it off", async () => {
    const mock = stubFetchRoutes([tokenRoute(), { match: isOauthHost, body: {} }]);
    const env = await fakeEnv();

    await redditGet(await openSession(env), env, "/r/newzealand/hot", { raw_json: "0", limit: 5 });

    const url = dataUrls(mock)[0];
    // Without it, every `&`, `<` and `>` in selftext and comment bodies comes back HTML-escaped.
    expect(url?.searchParams.get("raw_json")).toBe("1");
    expect(url?.searchParams.get("limit")).toBe("5");
  });

  it("omits undefined parameters rather than serialising them as the string 'undefined'", async () => {
    const mock = stubFetchRoutes([tokenRoute(), { match: isOauthHost, body: {} }]);
    const env = await fakeEnv();

    await redditGet(await openSession(env), env, "/search", { q: "kiwi", after: undefined });

    const url = dataUrls(mock)[0];
    expect(url?.searchParams.has("after")).toBe(false);
  });

  it("maps 403 on a data request to ForbiddenContentError — with a token, that means private or quarantined", async () => {
    stubFetchRoutes([tokenRoute(), { match: isOauthHost, status: 403, body: {} }]);
    const env = await fakeEnv();

    await expect(redditGet(await openSession(env), env, "/r/secret/hot")).rejects.toBeInstanceOf(ForbiddenContentError);
  });

  it("raises UpstreamHttpError for other non-2xx responses", async () => {
    stubFetchRoutes([tokenRoute(), { match: isOauthHost, status: 404, body: {} }]);
    const env = await fakeEnv();

    await expect(redditGet(await openSession(env), env, "/r/nope/hot")).rejects.toBeInstanceOf(UpstreamHttpError);
  });

  it("retries a 429 and succeeds when Reddit relents", async () => {
    const mock = stubFetchRoutes([
      tokenRoute(),
      {
        match: isOauthHost,
        sequence: [
          { status: 429, body: {}, headers: { "retry-after": "0" } },
          { status: 200, body: { ok: true } },
        ],
      },
    ]);
    const env = await fakeEnv();

    const result = await redditGet<{ ok: boolean }>(await openSession(env), env, "/r/newzealand/hot");

    expect(result.ok).toBe(true);
    expect(dataUrls(mock)).toHaveLength(2);
  });

  it("gives up after the backoff budget and surfaces the 429", async () => {
    stubFetchRoutes([tokenRoute(), { match: isOauthHost, status: 429, body: {}, headers: { "retry-after": "0" } }]);
    const env = await fakeEnv();

    await expect(redditGet(await openSession(env), env, "/r/newzealand/hot")).rejects.toMatchObject({
      name: "UpstreamHttpError",
    });
  });
});

describe("serially", () => {
  it("runs tasks one at a time, never overlapping", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const task = () => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return true;
    };

    // Reddit's 60 requests/minute budget is app-wide, so a Promise.all fan-out is the shape most
    // likely to earn a 429. This helper exists to make that structurally impossible.
    await serially([task(), task(), task()]);

    expect(maxInFlight).toBe(1);
  });

  it("preserves ordering", async () => {
    const order: number[] = [];
    await serially([1, 2, 3].map((n) => async () => order.push(n)));
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("userAgent", () => {
  it("strips a pasted u/ or /u/ prefix rather than producing (by /u//u/name)", () => {
    expect(normaliseUsername("u/bradley")).toBe("bradley");
    expect(normaliseUsername("/u/bradley")).toBe("bradley");
    expect(normaliseUsername("  bradley  ")).toBe("bradley");
  });

  it("truncates at the first illegal character rather than welding the fragments together", () => {
    // A CR/LF here would be a header-injection vector. Truncating stops at "brad"; stripping and
    // closing the gap would have produced the plausible-looking but wrong "bradleyevil".
    expect(normaliseUsername("brad\r\nley: evil")).toBe("brad");
    expect(normaliseUsername("bradley windybank")).toBe("bradley");
  });

  it("builds the exact format Reddit's API rules require", () => {
    expect(userAgent("bradley")).toBe("cloudflare-workers:iolab-reddit-mcp:v0.1.0 (by /u/bradley)");
  });
});
