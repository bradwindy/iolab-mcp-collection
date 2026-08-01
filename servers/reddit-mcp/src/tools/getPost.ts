import { z } from "zod";
import { CACHE_TTL, cacheKey, cached, textResult, toolError, type ToolTextResult } from "@iolab/mcp-kit";
import { buildCommentTree, countComments, flattenComments } from "../comments.js";
import { openSession } from "../clients/http.js";
import { getPostWithComments } from "../clients/reddit.js";
import { normaliseCommentId, normalisePostId } from "../ids.js";
import { renderPost, renderThread } from "../render.js";
import { relativeAge, toIso } from "../time.js";
import {
  attributionSchema,
  commentSchema,
  mapRedditError,
  moreCursorSchema,
  postSchema,
  redditAttribution,
} from "../toolSupport.js";
import type { CommentsResponse, CommentThing, PostData } from "../types.js";

export const getPostInputShape = {
  post: z
    .string()
    .min(1)
    .describe(
      "The post to read. Accepts a full URL (https://www.reddit.com/r/sub/comments/1abc2de/slug/, old.reddit.com " +
        "and https://redd.it/1abc2de included), a bare permalink (/r/sub/comments/1abc2de/…), a fullname " +
        "(t3_1abc2de), or a bare post id (1abc2de). Query strings are ignored. Mobile share links (/r/sub/s/…) " +
        "are opaque redirects and are rejected with instructions.",
    ),
  comment: z
    .string()
    .optional()
    .describe(
      "Focus on one comment's subtree instead of the whole thread — a comment id (h9k2j1a) or fullname " +
        "(t1_h9k2j1a). This is also the only way to follow a 'continue this thread' cursor, which " +
        "reddit_get_more_comments cannot expand. Filled in automatically when `post` is a comment permalink.",
    ),
  sort: z
    .enum(["best", "top", "new", "controversial", "old", "qa"])
    .default("top")
    .describe(
      "Comment ordering. 'top' is highest-scoring first, usually the fastest route to the consensus answer; " +
        "'best' is Reddit's confidence-weighted default; 'new' surfaces the latest replies; 'qa' pairs questions " +
        "with answers, which is the right choice for AMA threads; 'controversial' surfaces disputed comments.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Maximum top-level comments. Their replies are governed by `depth` and `max_chars`, not by this."),
  depth: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(3)
    .describe(
      "How many levels of replies to follow beneath each top-level comment. 0 returns top-level comments only. " +
        "Branches cut off here come back as cursors rather than being dropped.",
    ),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(12000)
    .describe(
      "Character budget for comment bodies. When it runs out the walk stops and the un-returned branches are " +
        "reported as expandable cursors, so truncation is always recoverable.",
    ),
  max_comment_chars: z
    .number()
    .int()
    .min(200)
    .max(10000)
    .default(1500)
    .describe("Per-comment cap, so one very long comment cannot consume the whole `max_chars` budget."),
  max_post_chars: z.number().int().min(500).max(40000).default(8000).describe("Cap on the post's own body text."),
  include_post_body: z.boolean().default(true).describe("Include the post's own text. Set false when you only want the discussion."),
};

export const getPostOutputShape = {
  post: postSchema,
  comments: z.array(commentSchema),
  more_cursors: z.array(moreCursorSchema),
  sort: z.string(),
  depth: z.number(),
  comments_shown: z.number(),
  comments_total: z.number(),
  truncated_by_budget: z.boolean(),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getPostInputShape);

/** `best` is what Reddit's UI calls it; the API's own name for that ordering is `confidence`. */
function apiSort(sort: string): string {
  return sort === "best" ? "confidence" : sort;
}

export async function getPostHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const ref = normalisePostId(input.post);
    // An explicit `comment` argument wins over one parsed out of a permalink: the caller asking for
    // a specific subtree is a stronger signal than the URL they happened to paste.
    const focus = input.comment !== undefined ? normaliseCommentId(input.comment) : ref.commentId;

    const session = await openSession(env);
    const key = await cacheKey(
      "reddit:post:v1",
      JSON.stringify([ref.postId, apiSort(input.sort), input.limit, input.depth, focus ?? ""]),
    );

    const response = await cached(env.MCP_CACHE, key, CACHE_TTL.NEAR_REALTIME, () =>
      getPostWithComments(session, env, {
        postId: ref.postId,
        sort: apiSort(input.sort) as never,
        limit: input.limit,
        // Ask Reddit for one level more than we intend to render, so a branch that really does end
        // is not reported as a continue-thread cursor that turns out to be empty.
        depth: input.depth + 1,
        ...(focus !== null ? { comment: focus } : {}),
      }),
    );

    // The endpoint answers with exactly two Listings. Anything else is a shape change or an error
    // body, and indexing blindly into it would surface as an opaque TypeError.
    if (!Array.isArray(response) || response.length < 2) {
      return toolError(
        "Reddit returned an unexpected shape for that post.",
        "The comments endpoint should answer with a two-element array. Retry; if it persists, the post may have been removed.",
      );
    }

    const [postListing, commentListing] = response as CommentsResponse;
    const postThing = postListing.data?.children?.[0];
    if (!postThing || postThing.kind !== "t3") {
      return toolError(
        `No Reddit post found for ${JSON.stringify(input.post)}.`,
        "If you passed a subreddit name, use reddit_list_subreddit_posts. If you passed a title, use " +
          "reddit_search_posts. `post` accepts a post id, a t3_ fullname, or a reddit.com permalink.",
      );
    }
    const post: PostData = postThing.data;

    const tree = buildCommentTree((commentListing.data?.children ?? []) as CommentThing[], {
      maxDepth: input.depth,
      maxTopLevel: input.limit,
      maxChars: input.max_chars,
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const shown = countComments(tree.comments);

    const markdown = [
      renderPost(post, { nowSeconds, maxPostChars: input.max_post_chars, includeBody: input.include_post_body }),
      "",
      renderThread(tree.comments, tree.cursors, {
        nowSeconds,
        maxCommentChars: input.max_comment_chars,
        sort: input.sort,
        maxDepth: input.depth,
        totalComments: post.num_comments,
        shownComments: shown,
      }),
    ].join("\n");

    const notices: string[] = [];
    if (tree.truncatedByBudget) {
      notices.push(`The ${input.max_chars}-character budget was reached; expand the cursors or raise max_chars.`);
    }
    if (focus !== null) notices.push(`Focused on comment ${focus} rather than the whole thread.`);

    return textResult(markdown, {
      post: {
        id: post.id,
        fullname: post.name,
        title: post.title,
        author: post.author,
        subreddit: post.subreddit,
        created_utc: post.created_utc,
        created_iso: toIso(post.created_utc),
        age: relativeAge(post.created_utc, nowSeconds),
        score: post.score,
        ...(typeof post.upvote_ratio === "number" ? { upvote_ratio: post.upvote_ratio } : {}),
        num_comments: post.num_comments,
        permalink: post.permalink,
        ...(post.url !== undefined ? { url: post.url } : {}),
        is_self: post.is_self === true,
        over_18: post.over_18 === true,
        spoiler: post.spoiler === true,
        locked: post.locked === true,
        stickied: post.stickied === true,
        archived: post.archived === true,
        ...(post.link_flair_text ? { flair: post.link_flair_text } : {}),
        ...(input.include_post_body && post.selftext ? { selftext_snippet: post.selftext.slice(0, input.max_post_chars) } : {}),
      },
      comments: flattenComments(tree.comments).map((comment) => ({
        id: comment.id,
        fullname: comment.fullname,
        parent_id: comment.parent_id,
        author: comment.author,
        body: comment.body,
        score: comment.score,
        created_utc: comment.created_utc,
        age: relativeAge(comment.created_utc, nowSeconds),
        depth: comment.depth,
        is_op: comment.is_op,
        stickied: comment.stickied,
        distinguished: comment.distinguished,
        collapsed: comment.collapsed,
        removed: comment.removed,
        deleted: comment.deleted,
      })),
      more_cursors: tree.cursors,
      sort: input.sort,
      depth: input.depth,
      comments_shown: shown,
      comments_total: post.num_comments,
      truncated_by_budget: tree.truncatedByBudget,
      notice: notices.join(" "),
      attribution: redditAttribution(),
    });
  } catch (error) {
    const mapped = mapRedditError(error, env.PORTAL_URL);
    if (mapped) return mapped;
    throw error;
  }
}
