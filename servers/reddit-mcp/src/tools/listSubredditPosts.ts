import { z } from "zod";
import { CACHE_TTL, cacheKey, cached, limitParam, textResult, type ToolTextResult } from "@iolab/mcp-kit";
import { openSession } from "../clients/http.js";
import { listSubredditPosts } from "../clients/reddit.js";
import { LISTING_CEILING } from "../constants.js";
import { normaliseSubreddit } from "../ids.js";
import { filterListing, toPostRow } from "../postRows.js";
import { renderPostList, VOTE_DATA_NOTE } from "../render.js";
import { attributionSchema, cursorParam, includeNsfwParam, mapRedditError, postSchema, redditAttribution } from "../toolSupport.js";
import type { Listing, PostThing } from "../types.js";

export const listSubredditPostsInputShape = {
  subreddit: z
    .string()
    .min(1)
    .describe(
      "Subreddit name without the 'r/' prefix, e.g. 'newzealand'. Multireddit syntax ('askhistorians+history') " +
        "works, as do the special feeds 'all' and 'popular'.",
    ),
  sort: z
    .enum(["hot", "new", "top", "rising"])
    .default("hot")
    .describe(
      "'hot' is what the subreddit's front page shows right now; 'new' is strictly chronological and the only " +
        "ordering stable enough to page deeply; 'top' is highest-scoring within `time`; 'rising' is gaining " +
        "traction fast but not yet hot.",
    ),
  time: z
    .enum(["hour", "day", "week", "month", "year", "all"])
    .default("day")
    .describe("Time window for `sort: 'top'`. Ignored by every other sort."),
  snippet_chars: z.number().int().min(0).max(2000).default(300).describe("Characters of each post's own text to include. 0 omits it."),
  include_nsfw: includeNsfwParam,
  limit: limitParam(100, 25),
  cursor: cursorParam,
};

export const listSubredditPostsOutputShape = {
  posts: z.array(postSchema),
  subreddit: z.string(),
  sort: z.string(),
  time: z.string(),
  returned: z.number(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  nsfw_filtered: z.number(),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(listSubredditPostsInputShape);

export async function listSubredditPostsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const subreddit = normaliseSubreddit(input.subreddit);
    const session = await openSession(env);

    // 'top' over a long window is genuinely slow-moving — the top posts of the year do not change
    // minute to minute — so it is worth a real cache. Everything else is a live front page and gets
    // the 60-second floor, which exists to absorb an agent re-running the same call, not to serve
    // stale Reddit.
    const ttl = input.sort === "top" && (input.time === "year" || input.time === "all") ? CACHE_TTL.SLOW_MOVING : CACHE_TTL.NEAR_REALTIME;

    const key = await cacheKey(
      "reddit:listing:v1",
      JSON.stringify([subreddit, input.sort, input.time, input.limit, input.cursor ?? "", input.include_nsfw]),
    );

    const listing = await cached(env.MCP_CACHE, key, ttl, () =>
      listSubredditPosts(session, env, {
        subreddit,
        sort: input.sort,
        time: input.time,
        limit: input.limit,
        ...(input.cursor !== undefined ? { after: input.cursor } : {}),
      }),
    );

    const nowSeconds = Math.floor(Date.now() / 1000);
    const { posts, nsfwFiltered, nextCursor } = filterListing(listing as Listing<PostThing>, input.include_nsfw);
    const rows = posts.map((post) => toPostRow(post, nowSeconds, input.snippet_chars));

    const notices: string[] = [];
    if (rows.length === 0) {
      notices.push(
        nsfwFiltered > 0
          ? `No visible posts — all ${nsfwFiltered} on this page are over-18. Set include_nsfw: true to see them.`
          : "No posts returned. Check the subreddit name with reddit_search_subreddits, or try a different sort.",
      );
    }
    if (nsfwFiltered > 0 && rows.length > 0) {
      notices.push(`${nsfwFiltered} over-18 post(s) were filtered out; set include_nsfw: true to include them.`);
    }
    if (nextCursor !== null) {
      notices.push(`Pass cursor: "${nextCursor}" for the next page. Reddit stops serving a listing past about ${LISTING_CEILING} items.`);
    }
    notices.push(VOTE_DATA_NOTE);

    const heading = `## r/${subreddit} — ${input.sort}${input.sort === "top" ? ` (${input.time})` : ""}`;
    const markdown = [heading, "", rows.length > 0 ? renderPostList(posts, nowSeconds, input.snippet_chars) : "_No posts._", "", ...notices.map((line) => `_${line}_`)].join(
      "\n",
    );

    return textResult(markdown, {
      posts: rows,
      subreddit,
      sort: input.sort,
      time: input.time,
      returned: rows.length,
      has_more: nextCursor !== null,
      next_cursor: nextCursor,
      nsfw_filtered: nsfwFiltered,
      notice: notices.join(" "),
      attribution: redditAttribution(),
    });
  } catch (error) {
    const mapped = mapRedditError(error, env.PORTAL_URL, "Check the subreddit name with reddit_search_subreddits.");
    if (mapped) return mapped;
    throw error;
  }
}
