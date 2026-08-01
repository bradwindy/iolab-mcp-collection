import { z } from "zod";
import { CACHE_TTL, cacheKey, cached, textResult, type ToolTextResult } from "@iolab/mcp-kit";
import { countComments, flattenComments, threadFlatComments, trimTree } from "../comments.js";
import { openSession } from "../clients/http.js";
import { getMoreChildren } from "../clients/reddit.js";
import { MORECHILDREN_BATCH_SIZE } from "../constants.js";
import { normaliseCommentId, normalisePostId } from "../ids.js";
import { renderThread } from "../render.js";
import { relativeAge } from "../time.js";
import { attributionSchema, commentSchema, mapRedditError, moreCursorSchema, redditAttribution } from "../toolSupport.js";

export const getMoreCommentsInputShape = {
  post: z
    .string()
    .min(1)
    .describe("The post these comments belong to — same accepted formats as reddit_get_post. Reddit's expansion endpoint is scoped to one post."),
  children: z
    .array(z.string())
    .min(1)
    .max(500)
    .describe(
      "Comment ids from a `more_cursors` entry with kind 'expandable', returned by reddit_get_post or a previous " +
        "call to this tool. A `continue_thread` cursor has no ids and cannot be expanded here — use " +
        "reddit_get_post with `comment` set to its parent_comment_id instead.",
    ),
  sort: z
    .enum(["best", "top", "new", "controversial", "old", "qa"])
    .default("top")
    .describe("Keep this the same as the reddit_get_post call that produced the cursor, or the expansion will not line up with the tree you already have."),
  max_batches: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .describe(
      "Maximum 100-id batches to fetch in one call. Reddit allows 60 requests per minute for this whole server, " +
        "so this defaults to 2 (200 comments); ids beyond the limit come back as a fresh cursor rather than " +
        "blocking on a long chain of round trips.",
    ),
  depth: z.number().int().min(0).max(10).default(3).describe("How deep to render the expanded branch."),
  max_chars: z.number().int().min(1000).max(60000).default(12000).describe("Character budget for the rendered result."),
  max_comment_chars: z.number().int().min(200).max(10000).default(1500).describe("Per-comment body cap."),
};

export const getMoreCommentsOutputShape = {
  comments: z.array(commentSchema),
  more_cursors: z.array(moreCursorSchema),
  requested: z.number(),
  fetched: z.number(),
  batches_used: z.number(),
  remaining_ids: z.array(z.string()),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getMoreCommentsInputShape);

function apiSort(sort: string): string {
  return sort === "best" ? "confidence" : sort;
}

export async function getMoreCommentsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const ref = normalisePostId(input.post);

    // Cursors carry bare ids, but `more.parent_id` and `more.name` are fullnames, so a model
    // round-tripping through the wrong field is a realistic mistake. Normalise defensively rather
    // than sending `t1_abc` to an endpoint that silently returns nothing for it.
    const ids = [...new Set(input.children.map((id) => normaliseCommentId(id)))];

    const maxIds = input.max_batches * MORECHILDREN_BATCH_SIZE;
    const requested = ids.slice(0, maxIds);
    const remaining = ids.slice(maxIds);

    const session = await openSession(env);
    const key = await cacheKey("reddit:more:v1", JSON.stringify([ref.fullname, apiSort(input.sort), [...requested].sort()]));

    const things = await cached(env.MCP_CACHE, key, CACHE_TTL.NEAR_REALTIME, () =>
      getMoreChildren(session, env, {
        linkFullname: ref.fullname,
        childIds: requested,
        sort: apiSort(input.sort) as never,
      }),
    );

    // Re-thread first, then apply the caller's depth and character budget. morechildren answers
    // with a flat list, so nesting does not exist until every node has been built — which is why
    // the budget is a second pass here rather than part of the walk, as it is in reddit_get_post.
    const threaded = threadFlatComments(things);
    const trimmed = trimTree(threaded.comments, { maxDepth: input.depth, maxChars: input.max_chars });
    const comments = trimmed.comments;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const shown = countComments(comments);

    const allCursors = [
      ...threaded.cursors,
      ...trimmed.cursors,
      // Anything past the batch cap is handed straight back as a cursor, so the caller can continue
      // explicitly rather than the server looping through a dozen round trips against a 60/min quota.
      ...(remaining.length > 0
        ? [
            {
              kind: "expandable" as const,
              child_ids: remaining,
              count: remaining.length,
              parent_comment_id: null,
              reason: "top_level_limit" as const,
            },
          ]
        : []),
    ];

    const notices: string[] = [];
    if (trimmed.truncatedByBudget) {
      notices.push(`The ${input.max_chars}-character budget was reached; expand the remaining cursors or raise max_chars.`);
    }
    if (remaining.length > 0) {
      notices.push(`${remaining.length} of the ${ids.length} requested ids were not fetched (max_batches: ${input.max_batches}); they are returned as a cursor.`);
    }
    if (shown === 0) {
      notices.push(
        "Reddit returned no comments for those ids. They may have been deleted, or the cursor may have come from a " +
          "different `sort` than the one passed here.",
      );
    }

    const markdown = [
      renderThread(comments, allCursors, {
        nowSeconds,
        maxCommentChars: input.max_comment_chars,
        sort: input.sort,
        maxDepth: input.depth,
        totalComments: ids.length,
        shownComments: shown,
      }),
      ...(notices.length > 0 ? ["", ...notices.map((line) => `_${line}_`)] : []),
    ].join("\n");

    return textResult(markdown, {
      comments: flattenComments(comments).map((comment) => ({
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
      more_cursors: allCursors,
      requested: ids.length,
      fetched: shown,
      batches_used: Math.ceil(requested.length / MORECHILDREN_BATCH_SIZE),
      remaining_ids: remaining,
      notice: notices.join(" "),
      attribution: redditAttribution(),
    });
  } catch (error) {
    const mapped = mapRedditError(error, env.PORTAL_URL);
    if (mapped) return mapped;
    throw error;
  }
}
