import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { listSubredditPostsHandler, listSubredditPostsOutputShape } from "../src/tools/listSubredditPosts.js";
import { dataUrls, fakeEnv, isOauthHost, listing, post, stubFetchRoutes, tokenRoute } from "./support/fakeEnv.js";

const outputSchema = z.object(listSubredditPostsOutputShape);
const listingRoute = (body: unknown) => ({ match: (url: string) => isOauthHost(url) && !url.includes("access_token"), body });

describe("reddit_list_subreddit_posts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists a subreddit and validates against the declared output schema", async () => {
    stubFetchRoutes([tokenRoute(), listingRoute(listing([post()]))]);

    const result = await listSubredditPostsHandler({ subreddit: "newzealand" }, await fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(() => outputSchema.parse(result.structuredContent)).not.toThrow();
    expect(result.content[0]?.text).toContain("## r/newzealand — hot");
  });

  it.each([["hot"], ["new"], ["rising"], ["top"]])("hits the %s path", async (sort) => {
    const mock = stubFetchRoutes([tokenRoute(), listingRoute(listing([]))]);

    await listSubredditPostsHandler({ subreddit: "newzealand", sort }, await fakeEnv());

    expect(dataUrls(mock)[0]?.pathname).toBe(`/r/newzealand/${sort}`);
  });

  it("sends the time window only for top, where it is the only sort it means anything to", async () => {
    const mock = stubFetchRoutes([tokenRoute(), listingRoute(listing([]))]);
    const env = await fakeEnv();

    await listSubredditPostsHandler({ subreddit: "newzealand", sort: "top", time: "year" }, env);
    await listSubredditPostsHandler({ subreddit: "newzealand", sort: "hot", time: "year" }, env);

    const [top, hot] = dataUrls(mock);
    expect(top?.searchParams.get("t")).toBe("year");
    expect(hot?.searchParams.has("t")).toBe(false);
  });

  it("accepts an r/-prefixed name and a full URL", async () => {
    const mock = stubFetchRoutes([tokenRoute(), listingRoute(listing([]))]);
    const env = await fakeEnv();

    await listSubredditPostsHandler({ subreddit: "r/newzealand" }, env);
    await listSubredditPostsHandler({ subreddit: "https://www.reddit.com/r/newzealand/" }, env);

    for (const url of dataUrls(mock)) expect(url.pathname).toBe("/r/newzealand/hot");
  });

  it("supports multireddits and the special feeds", async () => {
    const mock = stubFetchRoutes([tokenRoute(), listingRoute(listing([]))]);
    const env = await fakeEnv();

    await listSubredditPostsHandler({ subreddit: "askhistorians+history" }, env);
    await listSubredditPostsHandler({ subreddit: "all" }, env);

    expect(dataUrls(mock)[0]?.pathname).toBe("/r/askhistorians+history/hot");
    expect(dataUrls(mock)[1]?.pathname).toBe("/r/all/hot");
  });

  it("caches a long-window top listing for longer than a live front page", async () => {
    stubFetchRoutes([tokenRoute(), listingRoute(listing([post()]))]);
    const env = await fakeEnv();

    await listSubredditPostsHandler({ subreddit: "newzealand", sort: "top", time: "all" }, env);
    const topTtl = env.MCP_CACHE.puts.find((entry) => entry.key.startsWith("reddit:listing"))?.ttl;

    const env2 = await fakeEnv();
    await listSubredditPostsHandler({ subreddit: "newzealand", sort: "hot" }, env2);
    const hotTtl = env2.MCP_CACHE.puts.find((entry) => entry.key.startsWith("reddit:listing"))?.ttl;

    expect(topTtl).toBe(1800);
    expect(hotTtl).toBe(60);
  });

  it("filters over-18 posts by default and counts them", async () => {
    stubFetchRoutes([tokenRoute(), listingRoute(listing([post(), post({ id: "n", name: "t3_n", over_18: true })]))]);

    const result = await listSubredditPostsHandler({ subreddit: "newzealand" }, await fakeEnv());

    expect(result.structuredContent?.returned).toBe(1);
    expect(result.structuredContent?.nsfw_filtered).toBe(1);
  });

  it("round-trips the cursor and warns about Reddit's listing ceiling", async () => {
    const mock = stubFetchRoutes([tokenRoute(), listingRoute(listing([post()], "t3_next"))]);
    const env = await fakeEnv();

    const first = await listSubredditPostsHandler({ subreddit: "newzealand" }, env);
    expect(first.structuredContent?.next_cursor).toBe("t3_next");
    expect(first.content[0]?.text).toContain("1000 items");

    await listSubredditPostsHandler({ subreddit: "newzealand", cursor: "t3_next" }, env);
    expect(dataUrls(mock).at(-1)?.searchParams.get("after")).toBe("t3_next");
  });

  it("points at subreddit search when a name turns up nothing", async () => {
    stubFetchRoutes([tokenRoute(), listingRoute(listing([]))]);

    const result = await listSubredditPostsHandler({ subreddit: "nosuchplace" }, await fakeEnv());

    expect(result.content[0]?.text).toContain("reddit_search_subreddits");
  });

  it("distinguishes a missing subreddit (404) from a private one (403)", async () => {
    stubFetchRoutes([tokenRoute(), { match: (url: string) => isOauthHost(url) && !url.includes("access_token"), status: 404, body: {} }]);
    const notFound = await listSubredditPostsHandler({ subreddit: "nosuchplace" }, await fakeEnv());
    expect(notFound.content[0]?.text).toContain("no such post or subreddit");

    vi.unstubAllGlobals();
    stubFetchRoutes([tokenRoute(), { match: (url: string) => isOauthHost(url) && !url.includes("access_token"), status: 403, body: {} }]);
    const forbidden = await listSubredditPostsHandler({ subreddit: "secretplace" }, await fakeEnv());
    expect(forbidden.content[0]?.text).toContain("private, quarantined, or banned");
  });

  it("rejects a malformed subreddit name without calling Reddit", async () => {
    const mock = stubFetchRoutes([tokenRoute(), listingRoute(listing([]))]);

    const result = await listSubredditPostsHandler({ subreddit: "not a name!" }, await fakeEnv());

    expect(result.isError).toBe(true);
    expect(dataUrls(mock)).toHaveLength(0);
  });
});
