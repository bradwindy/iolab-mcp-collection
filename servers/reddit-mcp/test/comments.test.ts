import { describe, expect, it } from "vitest";
import { bareId, buildCommentTree, countComments, flattenComments, threadFlatComments, trimTree } from "../src/comments.js";
import type { CommentThing } from "../src/types.js";
import { more, t1 } from "./support/fakeEnv.js";

const build = (children: CommentThing[], overrides: Partial<Parameters<typeof buildCommentTree>[1]> = {}) =>
  buildCommentTree(children, { maxDepth: 3, maxTopLevel: 50, maxChars: 10_000, ...overrides });

/** A t1 whose `replies` is a real Listing rather than Reddit's empty string. */
const withReplies = (data: Record<string, unknown>, children: CommentThing[]): CommentThing =>
  t1({ ...data, replies: { kind: "Listing", data: { children, after: null, before: null } } });

describe("buildCommentTree", () => {
  it("treats Reddit's literal empty-string `replies` as no replies instead of crashing", () => {
    // Reddit really does send `"replies": ""` — not null, not an empty Listing. Assuming an object
    // here is the single most common crash in naive comment-tree code.
    const result = build([t1({ id: "a", replies: "" })]);

    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.replies).toEqual([]);
  });

  it("handles a null `replies` too", () => {
    expect(build([t1({ id: "a", replies: null })]).comments[0]?.replies).toEqual([]);
  });

  it("nests a real reply Listing and assigns increasing depth", () => {
    const result = build([withReplies({ id: "a" }, [withReplies({ id: "b" }, [t1({ id: "c" })])])]);

    expect(result.comments[0]?.id).toBe("a");
    expect(result.comments[0]?.depth).toBe(0);
    expect(result.comments[0]?.replies[0]?.id).toBe("b");
    expect(result.comments[0]?.replies[0]?.depth).toBe(1);
    expect(result.comments[0]?.replies[0]?.replies[0]?.depth).toBe(2);
    expect(countComments(result.comments)).toBe(3);
  });

  it("stops at maxDepth and reports the cut-off branch as a continue_thread cursor", () => {
    const result = build([withReplies({ id: "a" }, [t1({ id: "b" }), t1({ id: "c" })])], { maxDepth: 0 });

    expect(result.comments[0]?.replies).toEqual([]);
    expect(result.cursors).toEqual([
      { kind: "continue_thread", child_ids: [], count: 2, parent_comment_id: "a", reason: "depth_limit" },
    ]);
  });

  it("turns an upstream `more` stub into an expandable cursor carrying its ids", () => {
    const result = build([t1({ id: "a" }), more({ count: 12, children: ["x1", "x2"] })]);

    expect(result.cursors).toEqual([
      { kind: "expandable", child_ids: ["x1", "x2"], count: 12, parent_comment_id: null, reason: "upstream" },
    ]);
  });

  it("classifies a 'continue this thread' marker as non-expandable, not as an empty expandable one", () => {
    // Reddit marks these with id "_" and no children. morechildren cannot expand them; only a
    // fresh focused read reaches that subtree. Offering it as expandable produces an empty result
    // and a false "no more comments".
    const result = build([more({ id: "_", count: 0, children: [] })]);

    expect(result.cursors[0]?.kind).toBe("continue_thread");
    expect(result.cursors[0]?.child_ids).toEqual([]);
  });

  it("applies the top-level limit and hands back the skipped ids rather than dropping them", () => {
    const result = build([t1({ id: "a" }), t1({ id: "b" }), t1({ id: "c" }), t1({ id: "d" })], { maxTopLevel: 2 });

    expect(result.comments.map((comment) => comment.id)).toEqual(["a", "b"]);
    expect(result.cursors).toEqual([
      { kind: "expandable", child_ids: ["c", "d"], count: 2, parent_comment_id: null, reason: "top_level_limit" },
    ]);
  });

  it("does not apply the top-level limit to replies", () => {
    const result = build([withReplies({ id: "a" }, [t1({ id: "b" }), t1({ id: "c" }), t1({ id: "d" })])], { maxTopLevel: 1 });

    expect(result.comments[0]?.replies.map((reply) => reply.id)).toEqual(["b", "c", "d"]);
  });

  it("stops on the character budget and reports the remainder as an expandable cursor", () => {
    const long = "x".repeat(100);
    const result = build([t1({ id: "a", body: long }), t1({ id: "b", body: long }), t1({ id: "c", body: long })], {
      maxChars: 150,
    });

    expect(result.comments.map((comment) => comment.id)).toEqual(["a"]);
    expect(result.truncatedByBudget).toBe(true);
    expect(result.cursors).toEqual([
      { kind: "expandable", child_ids: ["b", "c"], count: 2, parent_comment_id: null, reason: "char_budget" },
    ]);
  });

  it("keeps a moderator-removed comment in place, with its replies, rather than orphaning the branch", () => {
    const result = build([withReplies({ id: "a", body: "[removed]", author: "someone" }, [t1({ id: "b", body: "context" })])]);

    expect(result.comments[0]?.removed).toBe(true);
    expect(result.comments[0]?.replies[0]?.body).toBe("context");
  });

  it("flags an author-deleted comment", () => {
    const result = build([t1({ id: "a", body: "[deleted]", author: "[deleted]" })]);

    expect(result.comments[0]?.deleted).toBe(true);
    expect(result.comments[0]?.author).toBe("[deleted]");
  });

  it("reports a hidden score as null rather than as zero", () => {
    // Reddit hides scores for roughly the first hour. Reporting 0 would read as "downvoted".
    const result = build([t1({ id: "a", score_hidden: true, score: 1 })]);
    expect(result.comments[0]?.score).toBeNull();
  });

  it("maps the flags that change how a comment should be read", () => {
    const result = build([
      t1({ id: "a", stickied: true, distinguished: "moderator", is_submitter: true, collapsed: true, edited: 1_700_000_500 }),
    ]);

    expect(result.comments[0]).toMatchObject({
      stickied: true,
      distinguished: "moderator",
      is_op: true,
      collapsed: true,
      edited: true,
    });
  });

  it("records the parent comment id so a flattened tree can still be re-nested", () => {
    const result = build([withReplies({ id: "a" }, [t1({ id: "b", parent_id: "t1_a" })])]);

    // Null for a top-level comment, NOT the post id: upstream sends the post's t3_ fullname there,
    // and surfacing that would make every top-level comment look like a reply to a sibling.
    expect(result.comments[0]?.parent_id).toBeNull();
    expect(result.comments[0]?.replies[0]?.parent_id).toBe("a");
  });
});

describe("buildCommentTree — cursors survive truncation", () => {
  it("carries a `more` stub from the skipped tail into the cursor instead of discarding it", () => {
    // Reddit puts its "load more comments" stub at the END of a sibling list, which is exactly the
    // region a budget or limit cut lands in. Filtering the tail to t1 things alone would silently
    // drop the branch the caller most needs, while the tool claims nothing is dropped silently.
    const long = "x".repeat(100);
    const result = build([t1({ id: "a", body: long }), t1({ id: "b", body: long }), more({ count: 50, children: ["m1", "m2"] })], {
      maxChars: 150,
    });

    const expandable = result.cursors.find((cursor) => cursor.kind === "expandable");
    expect(expandable?.child_ids).toEqual(["b", "m1", "m2"]);
    // 2 ids returned plus the 48 Reddit says are behind the stub beyond those ids.
    expect(expandable?.count).toBe(51);
  });

  it("keeps a continue-thread marker in the skipped tail as its own non-expandable cursor", () => {
    const long = "x".repeat(100);
    const result = build([t1({ id: "a", body: long }), t1({ id: "b", body: long }), more({ id: "_", count: 0, children: [] })], {
      maxChars: 150,
    });

    expect(result.cursors.some((cursor) => cursor.kind === "continue_thread")).toBe(true);
    const expandable = result.cursors.find((cursor) => cursor.kind === "expandable");
    expect(expandable?.child_ids).toEqual(["b"]);
  });

  it("carries a `more` stub past the top-level limit too", () => {
    const result = build([t1({ id: "a" }), t1({ id: "b" }), more({ count: 9, children: ["m1"] })], { maxTopLevel: 1 });

    expect(result.cursors.find((cursor) => cursor.reason === "top_level_limit")?.child_ids).toEqual(["b", "m1"]);
  });
});

describe("trimTree", () => {
  const tree = (): ReturnType<typeof build>["comments"] =>
    build([withReplies({ id: "a" }, [withReplies({ id: "b" }, [t1({ id: "c" })])])], { maxDepth: 5 }).comments;

  it("caps depth relative to each root while preserving the absolute depth used for indentation", () => {
    // An expanded branch has to indent consistently with the tree it is spliced back into, so the
    // cap applies to depth-below-the-root, not to the node's own reported depth.
    const roots = build([withReplies({ id: "a", depth: 4 }, [t1({ id: "b", depth: 5 })])], { maxDepth: 5 }).comments;
    const trimmed = trimTree(roots, { maxDepth: 0, maxChars: 10_000 });

    expect(trimmed.comments[0]?.depth).toBe(0);
    expect(trimmed.comments[0]?.replies).toEqual([]);
    expect(trimmed.cursors[0]).toMatchObject({ kind: "continue_thread", parent_comment_id: "a", reason: "depth_limit" });
  });

  it("enforces the character budget and reports the remainder as a cursor", () => {
    const long = "y".repeat(100);
    const roots = build([t1({ id: "a", body: long }), t1({ id: "b", body: long }), t1({ id: "c", body: long })]).comments;

    const trimmed = trimTree(roots, { maxDepth: 3, maxChars: 150 });

    expect(trimmed.comments.map((comment) => comment.id)).toEqual(["a"]);
    expect(trimmed.truncatedByBudget).toBe(true);
    expect(trimmed.cursors[0]).toMatchObject({ kind: "expandable", child_ids: ["b", "c"], reason: "char_budget" });
  });

  it("leaves a tree that fits entirely alone", () => {
    const trimmed = trimTree(tree(), { maxDepth: 5, maxChars: 10_000 });

    expect(countComments(trimmed.comments)).toBe(3);
    expect(trimmed.cursors).toEqual([]);
    expect(trimmed.truncatedByBudget).toBe(false);
  });
});

describe("threadFlatComments", () => {
  it("re-nests comments whose parent is in the same batch", () => {
    const { comments } = threadFlatComments([
      t1({ id: "a", parent_id: "t3_1abc2de", depth: 2 }),
      t1({ id: "b", parent_id: "t1_a", depth: 3 }),
    ]);

    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe("a");
    expect(comments[0]?.replies[0]?.id).toBe("b");
    expect(comments[0]?.replies[0]?.depth).toBe(3);
  });

  it("nests correctly even when a child appears before its parent in the flat array", () => {
    // morechildren returns a flat list in no guaranteed parent-first order, which is why the
    // implementation builds every node before wiring any of them up.
    const { comments } = threadFlatComments([t1({ id: "b", parent_id: "t1_a" }), t1({ id: "a", parent_id: "t3_1abc2de" })]);

    expect(comments.map((comment) => comment.id)).toEqual(["a"]);
    expect(comments[0]?.replies.map((reply) => reply.id)).toEqual(["b"]);
  });

  it("returns a comment whose parent is outside the batch as a root, keeping its parent id", () => {
    const { comments } = threadFlatComments([t1({ id: "b", parent_id: "t1_notinbatch", depth: 4 })]);

    expect(comments).toHaveLength(1);
    expect(comments[0]?.parent_id).toBe("notinbatch");
    // Depth is Reddit's, relative to the original tree, so the branch indents consistently with
    // the tree it is being spliced into.
    expect(comments[0]?.depth).toBe(4);
  });

  it("surfaces `more` things in the flat list as new cursors", () => {
    const { cursors } = threadFlatComments([more({ parent_id: "t1_a", count: 30, children: ["y1"] })]);

    expect(cursors).toEqual([
      { kind: "expandable", child_ids: ["y1"], count: 30, parent_comment_id: "a", reason: "upstream" },
    ]);
  });
});

describe("helpers", () => {
  it("strips any thing-type prefix, and passes an already-bare id through", () => {
    expect(bareId("t1_abc")).toBe("abc");
    expect(bareId("t3_abc")).toBe("abc");
    expect(bareId("abc")).toBe("abc");
    expect(bareId(undefined)).toBeNull();
  });

  it("flattens depth-first so document order survives the loss of nesting", () => {
    const result = build([withReplies({ id: "a" }, [t1({ id: "b" })]), t1({ id: "c" })]);

    expect(flattenComments(result.comments).map((comment) => comment.id)).toEqual(["a", "b", "c"]);
  });
});
