import { z } from "zod";
import { CACHE_TTL, cacheKey, cached, limitParam, textResult, toolError, type ToolTextResult } from "@iolab/mcp-kit";
import { openSession } from "../clients/http.js";
import { getSubredditAbout, searchSubreddits } from "../clients/reddit.js";
import { normaliseSubreddit } from "../ids.js";
import { renderSubredditList } from "../render.js";
import { attributionSchema, cursorParam, includeNsfwParam, mapRedditError, redditAttribution } from "../toolSupport.js";
import { toIso } from "../time.js";
import type { Listing, SubredditData, SubredditThing } from "../types.js";

export const searchSubredditsInputShape = {
  query: z
    .string()
    .optional()
    .describe("Search terms matched against subreddit names, titles, and descriptions. Supply this or `subreddit`, not both."),
  subreddit: z
    .string()
    .optional()
    .describe(
      "Look up one subreddit by exact name (no 'r/' prefix) instead of searching. Returns detail search does not: " +
        "the current online count, creation date, and whether the community is public, restricted, or private.",
    ),
  include_nsfw: includeNsfwParam,
  limit: limitParam(100, 25),
  cursor: cursorParam,
};

const subredditSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  subscribers: z.number().nullable(),
  active_users: z.number().nullable(),
  over_18: z.boolean(),
  type: z.string().optional(),
  created_utc: z.number().optional(),
  created_iso: z.string().optional(),
  url: z.string().optional(),
});

export const searchSubredditsOutputShape = {
  subreddits: z.array(subredditSchema),
  mode: z.enum(["search", "lookup"]),
  returned: z.number(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
  nsfw_filtered: z.number(),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(searchSubredditsInputShape);

function toRow(data: SubredditData) {
  return {
    name: data.display_name,
    ...(data.title ? { title: data.title } : {}),
    ...(data.public_description ? { description: data.public_description.trim() } : {}),
    subscribers: typeof data.subscribers === "number" ? data.subscribers : null,
    active_users: typeof data.active_user_count === "number" ? data.active_user_count : null,
    over_18: data.over18 === true,
    ...(data.subreddit_type ? { type: data.subreddit_type } : {}),
    ...(typeof data.created_utc === "number" ? { created_utc: data.created_utc, created_iso: toIso(data.created_utc) } : {}),
    ...(data.url ? { url: data.url } : {}),
  };
}

export async function searchSubredditsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  if ((input.query === undefined) === (input.subreddit === undefined)) {
    return toolError(
      "Supply exactly one of `query` or `subreddit`.",
      "`query` searches for communities by topic; `subreddit` looks one up by exact name.",
    );
  }

  try {
    const session = await openSession(env);
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Subreddit metadata is about as slow-moving as anything Reddit serves — names, descriptions
    // and subscriber counts change on a scale of days, not minutes.
    if (input.subreddit !== undefined) {
      const name = normaliseSubreddit(input.subreddit);
      const key = await cacheKey("reddit:subreddit:v1", name);
      const about = await cached(env.MCP_CACHE, key, CACHE_TTL.SLOW_MOVING, () => getSubredditAbout(session, env, name));
      const data = (about as SubredditThing).data;

      const notices: string[] = [];
      if (data.over18 === true && !input.include_nsfw) {
        notices.push("This community is marked over-18. It is still returned here because you named it explicitly.");
      }

      const markdown = [`## r/${data.display_name}`, "", renderSubredditList([data], nowSeconds), ...(notices.length > 0 ? ["", ...notices.map((line) => `_${line}_`)] : [])].join("\n");

      return textResult(markdown, {
        subreddits: [toRow(data)],
        mode: "lookup",
        returned: 1,
        has_more: false,
        next_cursor: null,
        nsfw_filtered: 0,
        notice: notices.join(" "),
        attribution: redditAttribution(),
      });
    }

    const query = input.query ?? "";
    const key = await cacheKey("reddit:subsearch:v1", JSON.stringify([query, input.limit, input.cursor ?? "", input.include_nsfw]));
    const listing = await cached(env.MCP_CACHE, key, CACHE_TTL.SLOW_MOVING, () =>
      searchSubreddits(session, env, {
        query,
        limit: input.limit,
        ...(input.cursor !== undefined ? { after: input.cursor } : {}),
        includeNsfw: input.include_nsfw,
      }),
    );

    const all = ((listing as Listing<SubredditThing>).data?.children ?? []).filter((child) => child.kind === "t5").map((child) => child.data);
    const visible = input.include_nsfw ? all : all.filter((data) => data.over18 !== true);
    const nextCursor = (listing as Listing<SubredditThing>).data?.after ?? null;

    const notices: string[] = [];
    if (visible.length === 0) notices.push("No communities matched. Try a broader term, or a topic word rather than an exact name.");
    if (all.length - visible.length > 0) notices.push(`${all.length - visible.length} over-18 community(ies) were filtered out; set include_nsfw: true to include them.`);
    if (nextCursor !== null) notices.push(`Pass cursor: "${nextCursor}" for the next page.`);

    const markdown = [
      `## Subreddit search — ${JSON.stringify(query)}`,
      "",
      visible.length > 0 ? renderSubredditList(visible, nowSeconds) : "_No communities matched._",
      ...(notices.length > 0 ? ["", ...notices.map((line) => `_${line}_`)] : []),
    ].join("\n");

    return textResult(markdown, {
      subreddits: visible.map((data) => toRow(data)),
      mode: "search",
      returned: visible.length,
      has_more: nextCursor !== null,
      next_cursor: nextCursor,
      nsfw_filtered: all.length - visible.length,
      notice: notices.join(" "),
      attribution: redditAttribution(),
    });
  } catch (error) {
    const mapped = mapRedditError(error, env.PORTAL_URL, "Check the subreddit name, or search by topic instead.");
    if (mapped) return mapped;
    throw error;
  }
}
