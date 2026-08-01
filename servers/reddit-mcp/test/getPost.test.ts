import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getPostHandler, getPostOutputShape } from "../src/tools/getPost.js";
import { commentsResponse, dataUrls, fakeEnv, isOauthHost, more, post, stubFetchRoutes, t1, tokenRoute } from "./support/fakeEnv.js";
import type { CommentThing } from "../src/types.js";

const outputSchema = z.object(getPostOutputShape);
const commentsRoute = (body: unknown) => ({ match: (url: string) => isOauthHost(url) && url.includes("/comments/"), body });

const withReplies = (data: Record<string, unknown>, children: CommentThing[]): CommentThing =>
  t1({ ...data, replies: { kind: "Listing", data: { children, after: null, before: null } } });

describe("reddit_get_post", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the post and its thread, and validates against the declared output schema", async () => {
    stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), [t1({ id: "a", body: "First." })]))]);

    const result = await getPostHandler({ post: "1abc2de" }, await fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(() => outputSchema.parse(result.structuredContent)).not.toThrow();
    expect(result.content[0]?.text).toContain("# A post about kiwi");
    expect(result.content[0]?.text).toContain("First.");
  });

  it.each([
    ["bare id", "1abc2de"],
    ["fullname", "t3_1abc2de"],
    ["full URL", "https://www.reddit.com/r/newzealand/comments/1abc2de/a_post_about_kiwi/"],
    ["short link", "https://redd.it/1abc2de"],
    ["bare permalink", "/r/newzealand/comments/1abc2de/slug/"],
  ])("resolves the %s form to the same upstream path", async (_label, input) => {
    const mock = stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), []))]);

    await getPostHandler({ post: input }, await fakeEnv());

    expect(dataUrls(mock)[0]?.pathname).toBe("/comments/1abc2de");
  });

  it("auto-focuses the comment named by a comment permalink", async () => {
    const mock = stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), []))]);

    await getPostHandler({ post: "https://www.reddit.com/r/nz/comments/1abc2de/slug/h9k2j1a/" }, await fakeEnv());

    expect(dataUrls(mock)[0]?.searchParams.get("comment")).toBe("h9k2j1a");
  });

  it("lets an explicit comment argument win over one parsed from the URL", async () => {
    const mock = stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), []))]);

    await getPostHandler(
      { post: "https://www.reddit.com/r/nz/comments/1abc2de/slug/h9k2j1a/", comment: "t1_other12" },
      await fakeEnv(),
    );

    expect(dataUrls(mock)[0]?.searchParams.get("comment")).toBe("other12");
  });

  it("maps the 'best' sort to the API's own name for that ordering", async () => {
    const mock = stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), []))]);

    await getPostHandler({ post: "1abc2de", sort: "best" }, await fakeEnv());

    // Reddit's UI calls it "best"; the API parameter value is "confidence".
    expect(dataUrls(mock)[0]?.searchParams.get("sort")).toBe("confidence");
  });

  it("survives a comment whose replies field is Reddit's literal empty string", async () => {
    stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), [t1({ id: "a", replies: "" })]))]);

    const result = await getPostHandler({ post: "1abc2de" }, await fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.comments_shown).toBe(1);
  });

  it("keeps a removed comment and its surviving replies in place", async () => {
    stubFetchRoutes([
      tokenRoute(),
      commentsRoute(commentsResponse(post(), [withReplies({ id: "a", body: "[removed]" }, [t1({ id: "b", body: "context" })])])),
    ]);

    const result = await getPostHandler({ post: "1abc2de" }, await fakeEnv());

    expect(result.content[0]?.text).toContain("_[removed by moderators]_");
    expect(result.content[0]?.text).toContain("context");
  });

  it("does not offer a continue-thread marker as expandable", async () => {
    stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), [more({ id: "_", count: 0, children: [] })]))]);

    const result = await getPostHandler({ post: "1abc2de" }, await fakeEnv());
    const cursors = result.structuredContent?.more_cursors as Array<Record<string, unknown>>;

    expect(cursors[0]?.kind).toBe("continue_thread");
    expect(cursors[0]?.child_ids).toEqual([]);
  });

  it("surfaces budget truncation as recoverable cursors rather than dropping comments", async () => {
    const long = "x".repeat(2000);
    stubFetchRoutes([
      tokenRoute(),
      commentsRoute(commentsResponse(post(), [t1({ id: "a", body: long }), t1({ id: "b", body: long }), t1({ id: "c", body: long })])),
    ]);

    const result = await getPostHandler({ post: "1abc2de", max_chars: 3000 }, await fakeEnv());

    expect(result.structuredContent?.truncated_by_budget).toBe(true);
    const cursors = result.structuredContent?.more_cursors as Array<Record<string, unknown>>;
    expect(cursors.some((cursor) => cursor.reason === "char_budget" && (cursor.child_ids as string[]).includes("c"))).toBe(true);
  });

  it("asks Reddit for one level deeper than it renders, so a real leaf is not mislabelled as truncated", async () => {
    const mock = stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), []))]);

    await getPostHandler({ post: "1abc2de", depth: 2 }, await fakeEnv());

    expect(dataUrls(mock)[0]?.searchParams.get("depth")).toBe("3");
  });

  it("honours include_post_body: false", async () => {
    stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), []))]);

    const result = await getPostHandler({ post: "1abc2de", include_post_body: false }, await fakeEnv());

    expect(result.content[0]?.text).not.toContain("flightless birds");
  });

  it("reads an over-18 post named explicitly, since NSFW filtering applies to search, not to this", async () => {
    stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post({ over_18: true }), [t1({ id: "a" })]))]);

    const result = await getPostHandler({ post: "1abc2de" }, await fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("[NSFW]");
  });

  it("says what to use instead when the reference resolves but no post comes back", async () => {
    stubFetchRoutes([
      tokenRoute(),
      commentsRoute([
        { kind: "Listing", data: { children: [], after: null, before: null } },
        { kind: "Listing", data: { children: [], after: null, before: null } },
      ]),
    ]);

    const result = await getPostHandler({ post: "notapost" }, await fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("reddit_list_subreddit_posts");
    expect(result.content[0]?.text).toContain("reddit_search_posts");
  });

  it("reports a shape change instead of throwing an opaque TypeError", async () => {
    stubFetchRoutes([tokenRoute(), commentsRoute({ not: "an array" })]);

    const result = await getPostHandler({ post: "1abc2de" }, await fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unexpected shape");
  });

  it("rejects a malformed reference with the list of forms it accepts", async () => {
    const mock = stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), []))]);

    const result = await getPostHandler({ post: "https://example.com/nope" }, await fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("t3_1abc2de");
    expect(dataUrls(mock)).toHaveLength(0);
  });

  it("returns score and upvote_ratio only, with no fabricated vote totals", async () => {
    stubFetchRoutes([tokenRoute(), commentsRoute(commentsResponse(post(), [t1({ id: "a", score: 42 })]))]);

    const result = await getPostHandler({ post: "1abc2de" }, await fakeEnv());
    const postOut = result.structuredContent?.post as Record<string, unknown>;
    const comments = result.structuredContent?.comments as Array<Record<string, unknown>>;

    expect(postOut.score).toBe(1247);
    expect(postOut.upvote_ratio).toBe(0.94);
    expect(postOut).not.toHaveProperty("ups");
    expect(comments[0]?.score).toBe(42);
    expect(comments[0]).not.toHaveProperty("upvote_ratio");
  });

  it("flattens comments with parent_id and depth so the nesting is still reconstructable", async () => {
    stubFetchRoutes([
      tokenRoute(),
      commentsRoute(commentsResponse(post(), [withReplies({ id: "a" }, [t1({ id: "b", parent_id: "t1_a" })])])),
    ]);

    const result = await getPostHandler({ post: "1abc2de" }, await fakeEnv());
    const comments = result.structuredContent?.comments as Array<Record<string, unknown>>;

    expect(comments.map((comment) => comment.id)).toEqual(["a", "b"]);
    expect(comments[1]?.parent_id).toBe("a");
    expect(comments[1]?.depth).toBe(1);
  });
});
