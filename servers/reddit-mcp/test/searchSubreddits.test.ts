import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { searchSubredditsHandler, searchSubredditsOutputShape } from "../src/tools/searchSubreddits.js";
import { dataUrls, fakeEnv, isOauthHost, stubFetchRoutes, subreddit, subredditListing, tokenRoute } from "./support/fakeEnv.js";

const outputSchema = z.object(searchSubredditsOutputShape);
const searchRoute = (body: unknown) => ({ match: (url: string) => isOauthHost(url) && url.includes("/subreddits/search"), body });
const aboutRoute = (body: unknown) => ({ match: (url: string) => isOauthHost(url) && url.includes("/about"), body });

describe("reddit_search_subreddits", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("searches by topic and validates against the declared output schema", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(subredditListing([subreddit()]))]);

    const result = await searchSubredditsHandler({ query: "new zealand" }, await fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(() => outputSchema.parse(result.structuredContent)).not.toThrow();
    expect(result.structuredContent?.mode).toBe("search");
    expect(result.content[0]?.text).toContain("**r/newzealand**");
    expect(result.content[0]?.text).toContain("500,000 subscribers");
  });

  it("looks one up by exact name via the about endpoint", async () => {
    const mock = stubFetchRoutes([tokenRoute(), aboutRoute({ kind: "t5", data: subreddit() })]);

    const result = await searchSubredditsHandler({ subreddit: "newzealand" }, await fakeEnv());

    expect(dataUrls(mock)[0]?.pathname).toBe("/r/newzealand/about");
    expect(result.structuredContent?.mode).toBe("lookup");
    expect(() => outputSchema.parse(result.structuredContent)).not.toThrow();
  });

  it("requires exactly one of query or subreddit", async () => {
    const mock = stubFetchRoutes([tokenRoute(), searchRoute(subredditListing([]))]);
    const env = await fakeEnv();

    const neither = await searchSubredditsHandler({}, env);
    const both = await searchSubredditsHandler({ query: "nz", subreddit: "newzealand" }, env);

    expect(neither.isError).toBe(true);
    expect(both.isError).toBe(true);
    expect(dataUrls(mock)).toHaveLength(0);
  });

  it("filters over-18 communities out of search by default", async () => {
    stubFetchRoutes([
      tokenRoute(),
      searchRoute(subredditListing([subreddit(), subreddit({ display_name: "spicy", over18: true })])),
    ]);

    const result = await searchSubredditsHandler({ query: "nz" }, await fakeEnv());

    expect(result.structuredContent?.returned).toBe(1);
    expect(result.structuredContent?.nsfw_filtered).toBe(1);
  });

  it("still returns an over-18 community that was named explicitly", async () => {
    // Filtering is about not surfacing NSFW unasked; a community the caller named is not unasked.
    stubFetchRoutes([tokenRoute(), aboutRoute({ kind: "t5", data: subreddit({ display_name: "spicy", over18: true }) })]);

    const result = await searchSubredditsHandler({ subreddit: "spicy" }, await fakeEnv());

    expect(result.structuredContent?.returned).toBe(1);
    expect(result.content[0]?.text).toContain("marked over-18");
  });

  it("reports the community type so the caller knows if it is private or restricted", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(subredditListing([subreddit({ subreddit_type: "restricted" })]))]);

    const result = await searchSubredditsHandler({ query: "nz" }, await fakeEnv());
    const rows = result.structuredContent?.subreddits as Array<Record<string, unknown>>;

    expect(rows[0]?.type).toBe("restricted");
    expect(result.content[0]?.text).toContain("restricted");
  });

  it("gives guidance rather than a bare empty list when nothing matches", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(subredditListing([]))]);

    const result = await searchSubredditsHandler({ query: "zzzzzz" }, await fakeEnv());

    expect(result.structuredContent?.returned).toBe(0);
    expect(result.content[0]?.text).toContain("broader term");
  });

  it("reports a null subscriber count honestly rather than as zero", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(subredditListing([subreddit({ subscribers: null })]))]);

    const result = await searchSubredditsHandler({ query: "nz" }, await fakeEnv());
    const rows = result.structuredContent?.subreddits as Array<Record<string, unknown>>;

    expect(rows[0]?.subscribers).toBeNull();
    expect(result.content[0]?.text).toContain("subscriber count unavailable");
  });

  it("round-trips the cursor", async () => {
    const mock = stubFetchRoutes([tokenRoute(), searchRoute(subredditListing([subreddit()], "t5_next"))]);
    const env = await fakeEnv();

    const first = await searchSubredditsHandler({ query: "nz" }, env);
    expect(first.structuredContent?.next_cursor).toBe("t5_next");

    await searchSubredditsHandler({ query: "nz", cursor: "t5_next" }, env);
    expect(dataUrls(mock).at(-1)?.searchParams.get("after")).toBe("t5_next");
  });

  it("surfaces a missing credential as an actionable error", async () => {
    stubFetchRoutes([tokenRoute(), searchRoute(subredditListing([]))]);

    const result = await searchSubredditsHandler({ query: "nz" }, await fakeEnv({ username: null }));

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("REDDIT_USERNAME");
  });
});
