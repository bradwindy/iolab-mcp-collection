import { z } from "zod";
import { CACHE_TTL, cacheKey, cached, limitParam, textResult, type ToolTextResult } from "@iolab/mcp-kit";
import { searchPosts } from "../clients/reddit.js";
import { openSession } from "../clients/http.js";
import { LISTING_CEILING } from "../constants.js";
import { normaliseSubreddit } from "../ids.js";
import { filterListing, toPostRow } from "../postRows.js";
import { renderPostList, VOTE_DATA_NOTE } from "../render.js";
import { attributionSchema, cursorParam, includeNsfwParam, mapRedditError, postSchema, redditAttribution } from "../toolSupport.js";
import type { Listing, PostThing } from "../types.js";

export const searchPostsInputShape = {
  query: z
    .string()
    .min(1)
    .describe(
      "Search terms. Also accepts Reddit's advanced syntax, combinable with AND / OR / NOT and parentheses: " +
        "`subreddit:algotrading`, `author:spez`, `title:\"order flow\"`, `selftext:backtest`, `flair:Education`, " +
        "`self:yes` for text posts only, `nsfw:no`, `site:arxiv.org`, `url:pdf`. Quote phrases for exact matches.",
    ),
  subreddit: z
    .string()
    .optional()
    .describe(
      "Restrict the search to one subreddit, without the 'r/' prefix. Prefer this over putting `subreddit:` in " +
        "`query` when you only need one community — it is exact rather than a scored term.",
    ),
  sort: z
    .enum(["relevance", "hot", "top", "new", "comments"])
    .default("relevance")
    .describe(
      "Result ordering. 'relevance' is Reddit's default blend; 'top' is highest-scoring within `time`; 'comments' " +
        "is most-discussed; 'new' is strictly chronological and is the only ordering stable enough to page deeply.",
    ),
  time: z
    .enum(["hour", "day", "week", "month", "year", "all"])
    .default("all")
    .describe("Time window the search covers. Affects 'top' and 'relevance'; ignored by 'new'."),
  snippet_chars: z
    .number()
    .int()
    .min(0)
    .max(2000)
    .default(300)
    .describe("Characters of each post's own text to include, so you can tell which result is worth opening. 0 omits it."),
  include_nsfw: includeNsfwParam,
  limit: limitParam(100, 25),
  cursor: cursorParam,
};

export const searchPostsOutputShape = {
  posts: z.array(postSchema),
  query: z.string(),
  subreddit: z.string().nullable(),
  sort: z.string(),
  time: z.string(),
  returned: z.number(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  nsfw_filtered: z.number(),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(searchPostsInputShape);

export async function searchPostsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const subreddit = input.subreddit === undefined ? undefined : normaliseSubreddit(input.subreddit);
    const session = await openSession(env);

    // The query is caller-supplied and unbounded, so the variable part is hashed when it would push
    // the key past Workers KV's 512-byte limit — an over-long key fails the read outright rather
    // than merely missing the cache. See cacheKey in @iolab/mcp-kit.
    const key = await cacheKey(
      "reddit:search:v1",
      JSON.stringify([input.query, subreddit ?? "", input.sort, input.time, input.limit, input.cursor ?? "", input.include_nsfw]),
    );

    const listing = await cached(env.MCP_CACHE, key, CACHE_TTL.NEAR_REALTIME, () =>
      searchPosts(session, env, {
        query: input.query,
        ...(subreddit !== undefined ? { subreddit } : {}),
        sort: input.sort,
        time: input.time,
        limit: input.limit,
        ...(input.cursor !== undefined ? { after: input.cursor } : {}),
        includeNsfw: input.include_nsfw,
      }),
    );

    const nowSeconds = Math.floor(Date.now() / 1000);
    const { posts, nsfwFiltered, nextCursor } = filterListing(listing as Listing<PostThing>, input.include_nsfw);
    const rows = posts.map((post) => toPostRow(post, nowSeconds, input.snippet_chars));

    const notices: string[] = [];
    if (rows.length === 0) {
      notices.push(
        nsfwFiltered > 0
          ? `No visible results — all ${nsfwFiltered} matches on this page are over-18. Set include_nsfw: true to see them.`
          : "No results. Try broader terms, a different `time` window, or drop the `subreddit` restriction.",
      );
    }
    if (nsfwFiltered > 0 && rows.length > 0) {
      notices.push(`${nsfwFiltered} over-18 result(s) were filtered out; set include_nsfw: true to include them.`);
    }
    if (nextCursor !== null) {
      notices.push(`Pass cursor: "${nextCursor}" for the next page. Reddit stops serving results past about ${LISTING_CEILING} items.`);
    }
    notices.push(VOTE_DATA_NOTE);

    const header = `## Reddit search — ${JSON.stringify(input.query)}${subreddit ? ` in r/${subreddit}` : ""}, sorted by "${input.sort}"`;
    const markdown = [header, "", rows.length > 0 ? renderPostList(posts, nowSeconds, input.snippet_chars) : "_No results._", "", ...notices.map((line) => `_${line}_`)].join(
      "\n",
    );

    return textResult(markdown, {
      posts: rows,
      query: input.query,
      subreddit: subreddit ?? null,
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
    const mapped = mapRedditError(error, env.PORTAL_URL, "Check the subreddit name, or widen the search.");
    if (mapped) return mapped;
    throw error;
  }
}
