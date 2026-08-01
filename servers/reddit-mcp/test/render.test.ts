import { describe, expect, it } from "vitest";
import type { TreeComment } from "../src/comments.js";
import { renderPost, renderPostList, renderSubredditList, renderThread, VOTE_DATA_NOTE } from "../src/render.js";
import { relativeAge } from "../src/time.js";
import { post, subreddit } from "./support/fakeEnv.js";

const NOW = 1_700_600_000;

function node(overrides: Partial<TreeComment> = {}): TreeComment {
  return {
    id: "c1",
    fullname: "t1_c1",
    parent_id: null,
    author: "alice",
    body: "A comment.",
    score: 42,
    created_utc: NOW - 3600,
    edited: false,
    depth: 0,
    is_op: false,
    stickied: false,
    distinguished: null,
    collapsed: false,
    removed: false,
    deleted: false,
    replies: [],
    ...overrides,
  };
}

const thread = (comments: TreeComment[], cursors: Parameters<typeof renderThread>[1] = []) =>
  renderThread(comments, cursors, {
    nowSeconds: NOW,
    maxCommentChars: 1500,
    sort: "top",
    maxDepth: 3,
    totalComments: 431,
    shownComments: comments.length,
  });

describe("renderThread", () => {
  it("indents two spaces per depth level", () => {
    const markdown = thread([node({ id: "a", replies: [node({ id: "b", depth: 1, replies: [node({ id: "c", depth: 2 })] })] })]);

    expect(markdown).toContain("\n- **u/alice**");
    expect(markdown).toContain("\n  - **u/alice**");
    expect(markdown).toContain("\n    - **u/alice**");
  });

  it("indents every line of a body so markdown inside a comment cannot break the enclosing list", () => {
    // Reddit comment bodies ARE markdown, so an un-indented body containing its own heading, list,
    // quote or fence terminates the list and collapses the whole thread's structure. This is the
    // single most likely rendering bug, so it gets the most explicit test.
    const body = ["# A heading", "- a list item", "> a quote", "```", "code()", "```"].join("\n");
    const markdown = thread([node({ body })]);

    for (const line of ["# A heading", "- a list item", "> a quote", "```", "code()"]) {
      expect(markdown).toContain(`\n  ${line}`);
    }
    expect(markdown).not.toMatch(/^# A heading$/m);
  });

  it("does not escape body markdown, so code blocks and quotes survive intact", () => {
    const markdown = thread([node({ body: "use `a < b` and *emphasis*" })]);
    expect(markdown).toContain("use `a < b` and *emphasis*");
  });

  it("renders a hidden score as 'score hidden' rather than as a number", () => {
    expect(thread([node({ score: null })])).toContain("score hidden");
  });

  it("uses the singular for a score of exactly one", () => {
    expect(thread([node({ score: 1 })])).toContain("1 pt");
    expect(thread([node({ score: 2 })])).toContain("2 pts");
  });

  it("marks OP, moderators, stickied, collapsed and edited comments", () => {
    const markdown = thread([node({ is_op: true, stickied: true, distinguished: "moderator", collapsed: true, edited: true })]);

    for (const marker of ["[OP]", "[mod]", "[stickied]", "[collapsed]", "[edited]"]) {
      expect(markdown).toContain(marker);
    }
  });

  it("renders removed and deleted bodies as placeholders rather than as literal bracket text", () => {
    expect(thread([node({ body: "[removed]", removed: true })])).toContain("_[removed by moderators]_");
    expect(thread([node({ body: "[deleted]", deleted: true })])).toContain("_[deleted by author]_");
  });

  it("truncates an over-long single comment instead of letting it swallow the budget", () => {
    const markdown = renderThread([node({ body: "x".repeat(500) })], [], {
      nowSeconds: NOW,
      maxCommentChars: 100,
      sort: "top",
      maxDepth: 3,
      totalComments: 1,
      shownComments: 1,
    });

    expect(markdown).toContain("[truncated at 100 of 500 characters]");
  });

  it("names an expandable branch with the tool and ids needed to fetch it", () => {
    const markdown = thread([node()], [
      { kind: "expandable", child_ids: ["x1", "x2"], count: 12, parent_comment_id: "c1", reason: "upstream" },
    ]);

    expect(markdown).toContain("reddit_get_more_comments");
    expect(markdown).toContain('"x1"');
    expect(markdown).toContain("`c1`");
  });

  it("tells the caller to use reddit_get_post for a continue_thread cursor, not morechildren", () => {
    const markdown = thread([node()], [
      { kind: "continue_thread", child_ids: [], count: 12, parent_comment_id: "c1", reason: "depth_limit" },
    ]);

    expect(markdown).toContain("reddit_get_post");
    expect(markdown).toContain('comment: "c1"');
    expect(markdown).not.toContain("reddit_get_more_comments");
  });

  it("states honestly how many of the post's comments are shown", () => {
    expect(thread([node()])).toContain("1 of 431 shown");
  });

  it("always carries the vote-data caveat, which is the anti-hallucination line", () => {
    expect(thread([node()])).toContain(VOTE_DATA_NOTE);
  });

  it("says so when there are no comments rather than rendering an empty section", () => {
    expect(thread([])).toContain("No comments were returned");
  });
});

describe("renderPost", () => {
  const opts = { nowSeconds: NOW, maxPostChars: 8000, includeBody: true };

  it("renders the title, byline and canonical link", () => {
    const markdown = renderPost(post(), opts);

    expect(markdown).toContain("# A post about kiwi");
    expect(markdown).toContain("r/newzealand");
    expect(markdown).toContain("u/quantcurious");
    expect(markdown).toContain("1,247 pts");
    expect(markdown).toContain("94% upvoted");
    expect(markdown).toContain("431 comments");
    expect(markdown).toContain("https://www.reddit.com/r/newzealand/comments/1abc2de/a_post_about_kiwi/");
    expect(markdown).toContain("`t3_1abc2de`");
  });

  it("omits the upvote ratio when Reddit does not report one, rather than inventing a percentage", () => {
    const { upvote_ratio, ...withoutRatio } = post();
    void upvote_ratio;
    expect(renderPost(withoutRatio, opts)).not.toContain("% upvoted");
  });

  it("shows the link target for a link post instead of an empty body", () => {
    const markdown = renderPost(post({ is_self: false, url: "https://example.com/article", selftext: "" }), opts);
    expect(markdown).toContain("Link: https://example.com/article");
  });

  it("shows both link and text when a post carries both, as crossposts and galleries do", () => {
    const markdown = renderPost(post({ is_self: false, url: "https://example.com/a", selftext: "Some commentary." }), opts);
    expect(markdown).toContain("Link: https://example.com/a");
    expect(markdown).toContain("Some commentary.");
  });

  it("omits the body entirely when asked to", () => {
    expect(renderPost(post(), { ...opts, includeBody: false })).not.toContain("flightless birds");
  });

  it("marks NSFW, locked, spoiler, archived and flair", () => {
    const markdown = renderPost(post({ over_18: true, locked: true, spoiler: true, archived: true, link_flair_text: "Education" }), opts);

    for (const marker of ["[NSFW]", "[locked]", "[spoiler]", "[archived]", "Flair: Education"]) {
      expect(markdown).toContain(marker);
    }
  });

  it("truncates a very long post body", () => {
    expect(renderPost(post({ selftext: "y".repeat(500) }), { ...opts, maxPostChars: 100 })).toContain("[truncated at 100 of 500 characters]");
  });
});

describe("renderPostList", () => {
  it("prints the fullname on every row so it can be passed straight to reddit_get_post", () => {
    const markdown = renderPostList([post()], NOW, 300);
    expect(markdown).toContain("`t3_1abc2de`");
    expect(markdown).toContain("1. **A post about kiwi**");
  });

  it("includes a snippet, clipped to the requested length", () => {
    const markdown = renderPostList([post({ selftext: "z".repeat(500) })], NOW, 50);
    expect(markdown).toContain("z".repeat(50));
    expect(markdown).not.toContain("z".repeat(51));
  });

  it("omits the snippet entirely when the caller asks for none", () => {
    expect(renderPostList([post()], NOW, 0)).not.toContain("flightless");
  });
});

describe("renderSubredditList", () => {
  it("renders name, subscribers and description", () => {
    const markdown = renderSubredditList([subreddit()], NOW);

    expect(markdown).toContain("**r/newzealand**");
    expect(markdown).toContain("500,000 subscribers");
    expect(markdown).toContain("Kia ora and welcome.");
  });

  it("says the count is unavailable rather than printing 0 when Reddit withholds it", () => {
    expect(renderSubredditList([subreddit({ subscribers: null })], NOW)).toContain("subscriber count unavailable");
  });
});

describe("relativeAge", () => {
  it.each([
    [30, "just now"],
    [5 * 60, "5m ago"],
    [3 * 3600, "3h ago"],
    [3 * 86400, "3d ago"],
    [70 * 86400, "2mo ago"],
    [800 * 86400, "2y ago"],
  ])("renders %s seconds ago as %s", (elapsed, expected) => {
    expect(relativeAge(NOW - elapsed, NOW)).toBe(expected);
  });

  it("does not produce a negative age when Reddit's clock is slightly ahead", () => {
    expect(relativeAge(NOW + 5, NOW)).toBe("just now");
  });
});
