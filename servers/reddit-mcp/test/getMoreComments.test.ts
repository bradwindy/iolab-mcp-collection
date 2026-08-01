import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getMoreCommentsHandler, getMoreCommentsOutputShape } from "../src/tools/getMoreComments.js";
import { dataUrls, fakeEnv, isOauthHost, more, stubFetchRoutes, t1, tokenRoute } from "./support/fakeEnv.js";
import type { CommentThing } from "../src/types.js";

const outputSchema = z.object(getMoreCommentsOutputShape);

const moreRoute = (things: CommentThing[]) => ({
  match: (url: string) => isOauthHost(url) && url.includes("/api/morechildren"),
  body: { json: { errors: [], data: { things } } },
});

const ids = (count: number, prefix = "id") => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

describe("reddit_get_more_comments", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("expands a cursor and validates against the declared output schema", async () => {
    stubFetchRoutes([tokenRoute(), moreRoute([t1({ id: "x1", body: "Expanded." })])]);

    const result = await getMoreCommentsHandler({ post: "1abc2de", children: ["x1"] }, await fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(() => outputSchema.parse(result.structuredContent)).not.toThrow();
    expect(result.content[0]?.text).toContain("Expanded.");
  });

  it("sends the post's t3_ fullname as link_id, with the ids comma-joined", async () => {
    const mock = stubFetchRoutes([tokenRoute(), moreRoute([])]);

    await getMoreCommentsHandler({ post: "1abc2de", children: ["x1", "x2"] }, await fakeEnv());

    const url = dataUrls(mock)[0];
    expect(url?.pathname).toBe("/api/morechildren");
    expect(url?.searchParams.get("link_id")).toBe("t3_1abc2de");
    expect(url?.searchParams.get("children")).toBe("x1,x2");
    expect(url?.searchParams.get("api_type")).toBe("json");
  });

  it("batches at Reddit's 100-id ceiling, serially", async () => {
    const mock = stubFetchRoutes([tokenRoute(), moreRoute([])]);

    await getMoreCommentsHandler({ post: "1abc2de", children: ids(150) }, await fakeEnv());

    const calls = dataUrls(mock);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.searchParams.get("children")?.split(",")).toHaveLength(100);
    expect(calls[1]?.searchParams.get("children")?.split(",")).toHaveLength(50);
  });

  it("hands back ids beyond the batch cap as a fresh cursor rather than looping for minutes", async () => {
    const mock = stubFetchRoutes([tokenRoute(), moreRoute([])]);

    const result = await getMoreCommentsHandler({ post: "1abc2de", children: ids(350), max_batches: 2 }, await fakeEnv());

    expect(dataUrls(mock)).toHaveLength(2);
    expect((result.structuredContent?.remaining_ids as string[]).length).toBe(150);
    expect(result.structuredContent?.batches_used).toBe(2);
    expect(result.content[0]?.text).toContain("were not fetched");
  });

  it("re-threads the flat response Reddit returns into a real tree", async () => {
    // morechildren answers with every comment at the same level regardless of nesting.
    stubFetchRoutes([
      tokenRoute(),
      moreRoute([t1({ id: "a", parent_id: "t3_1abc2de", body: "parent" }), t1({ id: "b", parent_id: "t1_a", body: "child" })]),
    ]);

    const result = await getMoreCommentsHandler({ post: "1abc2de", children: ["a", "b"] }, await fakeEnv());

    expect(result.content[0]?.text).toContain("\n- **u/alice**");
    expect(result.content[0]?.text).toContain("\n  - **u/alice**");
    const comments = result.structuredContent?.comments as Array<Record<string, unknown>>;
    expect(comments.map((comment) => comment.id)).toEqual(["a", "b"]);
    expect(comments[1]?.parent_id).toBe("a");
  });

  it("accepts fullnames as well as bare ids, since a model may round-trip the wrong field", async () => {
    const mock = stubFetchRoutes([tokenRoute(), moreRoute([])]);

    await getMoreCommentsHandler({ post: "1abc2de", children: ["t1_x1", "x2"] }, await fakeEnv());

    expect(dataUrls(mock)[0]?.searchParams.get("children")).toBe("x1,x2");
  });

  it("de-duplicates repeated ids rather than paying for them twice", async () => {
    const mock = stubFetchRoutes([tokenRoute(), moreRoute([])]);

    await getMoreCommentsHandler({ post: "1abc2de", children: ["x1", "x1", "t1_x1", "x2"] }, await fakeEnv());

    expect(dataUrls(mock)[0]?.searchParams.get("children")).toBe("x1,x2");
  });

  it("surfaces a nested `more` in the response as a further cursor", async () => {
    stubFetchRoutes([tokenRoute(), moreRoute([more({ parent_id: "t1_a", count: 30, children: ["y1"] })])]);

    const result = await getMoreCommentsHandler({ post: "1abc2de", children: ["x1"] }, await fakeEnv());
    const cursors = result.structuredContent?.more_cursors as Array<Record<string, unknown>>;

    expect(cursors[0]).toMatchObject({ kind: "expandable", child_ids: ["y1"], parent_comment_id: "a" });
  });

  it("explains an empty expansion instead of implying the branch is exhausted", async () => {
    stubFetchRoutes([tokenRoute(), moreRoute([])]);

    const result = await getMoreCommentsHandler({ post: "1abc2de", children: ["x1"] }, await fakeEnv());

    expect(result.structuredContent?.fetched).toBe(0);
    expect(result.content[0]?.text).toContain("different `sort`");
  });

  it("keeps the sort consistent with the call that produced the cursor", async () => {
    const mock = stubFetchRoutes([tokenRoute(), moreRoute([])]);

    await getMoreCommentsHandler({ post: "1abc2de", children: ["x1"], sort: "new" }, await fakeEnv());

    expect(dataUrls(mock)[0]?.searchParams.get("sort")).toBe("new");
  });

  it("rejects an empty id list at the schema, since that is the continue_thread mistake", async () => {
    stubFetchRoutes([tokenRoute(), moreRoute([])]);

    await expect(getMoreCommentsHandler({ post: "1abc2de", children: [] }, await fakeEnv())).rejects.toThrow();
  });

  it("surfaces Reddit's json.errors envelope instead of reporting it as an empty expansion", async () => {
    // morechildren reports failures with a 200 status, so ignoring the envelope turns a real error
    // into the misleading "those comments may have been deleted" notice.
    stubFetchRoutes([
      tokenRoute(),
      {
        match: (url: string) => isOauthHost(url) && url.includes("/api/morechildren"),
        body: { json: { errors: [["BAD_ID", "that id is not valid", "children"]], data: { things: [] } } },
      },
    ]);

    const result = await getMoreCommentsHandler({ post: "1abc2de", children: ["x1"] }, await fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("rejected the comment expansion");
    expect(result.content[0]?.text).toContain("BAD_ID");
  });

  it("actually enforces max_chars, rather than accepting it and rendering everything", async () => {
    const long = "z".repeat(400);
    stubFetchRoutes([
      tokenRoute(),
      moreRoute([t1({ id: "a", body: long }), t1({ id: "b", body: long }), t1({ id: "c", body: long })]),
    ]);

    // Two 400-character bodies fit inside the 1,000-character budget; the third does not.
    const result = await getMoreCommentsHandler({ post: "1abc2de", children: ["a", "b", "c"], max_chars: 1000 }, await fakeEnv());

    expect(result.structuredContent?.fetched).toBe(2);
    expect(result.content[0]?.text).toContain("character budget was reached");
    const cursors = result.structuredContent?.more_cursors as Array<Record<string, unknown>>;
    expect(cursors.some((cursor) => cursor.reason === "char_budget")).toBe(true);
  });

  it("actually enforces depth, capping relative to each expanded root", async () => {
    stubFetchRoutes([
      tokenRoute(),
      moreRoute([t1({ id: "a", parent_id: "t3_1abc2de" }), t1({ id: "b", parent_id: "t1_a" })]),
    ]);

    const result = await getMoreCommentsHandler({ post: "1abc2de", children: ["a", "b"], depth: 0 }, await fakeEnv());

    expect(result.structuredContent?.fetched).toBe(1);
    const cursors = result.structuredContent?.more_cursors as Array<Record<string, unknown>>;
    expect(cursors.some((cursor) => cursor.reason === "depth_limit" && cursor.parent_comment_id === "a")).toBe(true);
  });

  it("hashes the cache key for a long id list rather than exceeding KV's key limit", async () => {
    stubFetchRoutes([tokenRoute(), moreRoute([])]);
    const env = await fakeEnv();

    await getMoreCommentsHandler({ post: "1abc2de", children: ids(500), max_batches: 5 }, env);

    const key = env.MCP_CACHE.puts.map((entry) => entry.key).find((entry) => entry.startsWith("reddit:more"));
    expect(key).toMatch(/^reddit:more:v1:sha256-[0-9a-f]{64}$/);
  });
});
