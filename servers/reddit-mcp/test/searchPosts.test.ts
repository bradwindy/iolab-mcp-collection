import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { searchPostsHandler, searchPostsOutputShape } from "../src/tools/searchPosts.js";
import { dataUrls, fakeEnv, isOauthHost, listing, post, stubFetchRoutes, tokenRoute } from "./support/fakeEnv.js";

const outputSchema = z.object(searchPostsOutputShape);
const searchRoute = (body: unknown) => ({ match: (url: string) => isOauthHost(url) && url.includes("/search"), body });

describe("reddit_search_posts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("searches all of Reddit and returns rows that validate against the declared output schema", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(listing([post()]))]);

    const result = await searchPostsHandler({ query: "kiwi" }, await fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(() => outputSchema.parse(result.structuredContent)).not.toThrow();
    expect(result.content[0]?.text).toContain("A post about kiwi");
    expect(result.content[0]?.text).toContain("`t3_1abc2de`");
  });

  it("returns markdown rather than a JSON dump as the human-facing content", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(listing([post()]))]);

    const result = await searchPostsHandler({ query: "kiwi" }, await fakeEnv());

    expect(result.content[0]?.text.startsWith("## Reddit search")).toBe(true);
    expect(() => JSON.parse(result.content[0]?.text ?? "")).toThrow();
  });

  it("restricts to one subreddit via the subreddit-scoped path and restrict_sr", async () => {
    const mock = stubFetchRoutes([tokenRoute(), searchRoute(listing([post()]))]);

    await searchPostsHandler({ query: "kiwi", subreddit: "newzealand" }, await fakeEnv());

    const url = dataUrls(mock)[0];
    expect(url?.pathname).toBe("/r/newzealand/search");
    expect(url?.searchParams.get("restrict_sr")).toBe("on");
  });

  it("passes sort, time and limit through to Reddit", async () => {
    const mock = stubFetchRoutes([tokenRoute(), searchRoute(listing([]))]);

    await searchPostsHandler({ query: "kiwi", sort: "top", time: "year", limit: 5 }, await fakeEnv());

    const url = dataUrls(mock)[0];
    expect(url?.searchParams.get("sort")).toBe("top");
    expect(url?.searchParams.get("t")).toBe("year");
    expect(url?.searchParams.get("limit")).toBe("5");
    expect(url?.searchParams.get("type")).toBe("link");
  });

  it("filters over-18 results by default and says how many it dropped", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(listing([post(), post({ id: "nsfw1", name: "t3_nsfw1", over_18: true })]))]);

    const result = await searchPostsHandler({ query: "kiwi" }, await fakeEnv());

    expect(result.structuredContent?.returned).toBe(1);
    expect(result.structuredContent?.nsfw_filtered).toBe(1);
    expect(result.content[0]?.text).toContain("include_nsfw: true");
  });

  it("includes over-18 results on opt-in and tells Reddit to as well", async () => {
    const mock = stubFetchRoutes([tokenRoute(), searchRoute(listing([post({ over_18: true })]))]);

    const result = await searchPostsHandler({ query: "kiwi", include_nsfw: true }, await fakeEnv());

    expect(result.structuredContent?.returned).toBe(1);
    expect(dataUrls(mock)[0]?.searchParams.get("include_over_18")).toBe("on");
  });

  it("reports Reddit's cursor rather than a synthesised offset, and passes one back verbatim", async () => {
    const mock = stubFetchRoutes([tokenRoute(), searchRoute(listing([post()], "t3_next"))]);

    const first = await searchPostsHandler({ query: "kiwi" }, await fakeEnv());
    expect(first.structuredContent?.next_cursor).toBe("t3_next");
    expect(first.structuredContent?.has_more).toBe(true);

    await searchPostsHandler({ query: "kiwi", cursor: "t3_next" }, await fakeEnv());
    expect(dataUrls(mock).at(-1)?.searchParams.get("after")).toBe("t3_next");
  });

  it("reports no further pages when Reddit's after is null", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(listing([post()], null))]);

    const result = await searchPostsHandler({ query: "kiwi" }, await fakeEnv());

    expect(result.structuredContent?.has_more).toBe(false);
    expect(result.structuredContent?.next_cursor).toBeNull();
  });

  it("gives actionable guidance rather than a bare empty list when nothing matches", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(listing([]))]);

    const result = await searchPostsHandler({ query: "asdkjhasd" }, await fakeEnv());

    expect(result.structuredContent?.returned).toBe(0);
    expect(result.content[0]?.text).toContain("broader terms");
  });

  it("hashes the cache key for an unbounded query instead of blowing KV's 512-byte key limit", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(listing([post()]))]);
    const env = await fakeEnv();

    // A real KV get()/put() throws on an over-long key, so this would fail the read outright.
    await expect(searchPostsHandler({ query: "kiwi ".repeat(300) }, env)).resolves.toBeDefined();

    const searchKey = env.MCP_CACHE.puts.map((entry) => entry.key).find((key) => key.startsWith("reddit:search"));
    expect(searchKey).toMatch(/^reddit:search:v1:sha256-[0-9a-f]{64}$/);
  });

  it("serves a repeated identical search from cache instead of spending the rate-limit budget twice", async () => {
    const mock = stubFetchRoutes([tokenRoute(), searchRoute(listing([post()]))]);
    const env = await fakeEnv();

    await searchPostsHandler({ query: "kiwi" }, env);
    await searchPostsHandler({ query: "kiwi" }, env);

    expect(dataUrls(mock)).toHaveLength(1);
  });

  it("returns an actionable missing-credential error naming the key and the portal", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(listing([]))]);

    const result = await searchPostsHandler({ query: "kiwi" }, await fakeEnv({ clientId: null }));

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("REDDIT_CLIENT_ID");
    expect(result.content[0]?.text).toContain("https://portal.example/admin/servers/reddit-mcp");
  });

  it("explains that bad app credentials are a configuration problem, not a transient failure", async () => {
    stubFetchRoutes([{ match: (url: string) => url.includes("access_token"), status: 401, body: {} }]);

    const result = await searchPostsHandler({ query: "kiwi" }, await fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("REDDIT_CLIENT_SECRET");
    expect(result.content[0]?.text).toContain("script");
  });

  it("explains a 403 as a private or quarantined community rather than as a retryable error", async () => {
    stubFetchRoutes([tokenRoute(), { match: isOauthHost, status: 403, body: {} }]);

    const result = await searchPostsHandler({ query: "kiwi", subreddit: "secret" }, await fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("private, quarantined, or banned");
  });

  it("rejects an invalid subreddit name with guidance instead of calling Reddit", async () => {
    const mock = stubFetchRoutes([tokenRoute(), searchRoute(listing([]))]);

    const result = await searchPostsHandler({ query: "kiwi", subreddit: "not a subreddit!" }, await fakeEnv());

    expect(result.isError).toBe(true);
    expect(dataUrls(mock)).toHaveLength(0);
  });

  it("never invents a vote total, and says so in the output", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(listing([post()]))]);

    const result = await searchPostsHandler({ query: "kiwi" }, await fakeEnv());
    const row = (result.structuredContent?.posts as Array<Record<string, unknown>>)[0];

    expect(row).toHaveProperty("score", 1247);
    expect(row).toHaveProperty("upvote_ratio", 0.94);
    expect(row).not.toHaveProperty("ups");
    expect(row).not.toHaveProperty("downs");
    expect(row).not.toHaveProperty("estimated_total_votes");
    expect(result.content[0]?.text).toContain("deliberately fuzzed");
  });
});
