import { z } from "zod";
import { attribution, missingCredentialError, toolError, UpstreamHttpError, upstreamError, type ToolTextResult } from "@iolab/mcp-kit";
import { NoAccessTokenError } from "./auth.js";
import { ForbiddenContentError } from "./clients/http.js";
import { MoreChildrenError } from "./clients/reddit.js";
import { REDDIT_WEB_BASE, SERVER_SLUG } from "./constants.js";
import { InvalidCredentialsError, MissingCredentialError } from "./credentials.js";
import { InvalidSubredditError, UnrecognisedPostReferenceError } from "./ids.js";
import { VOTE_DATA_NOTE } from "./render.js";

/**
 * Reddit content is user-generated and licensed under Reddit's User Agreement, not an open licence,
 * so `license` is deliberately omitted rather than guessed. What matters downstream is that the
 * content is attributed to Reddit and its authors rather than presented as the assistant's own.
 */
export function redditAttribution() {
  return attribution("Reddit", { url: REDDIT_WEB_BASE });
}

export const attributionSchema = z.object({
  source: z.string(),
  license: z.string().optional(),
  url: z.string().optional(),
});

/**
 * Map the errors every tool here can raise to actionable tool-execution errors.
 *
 * Returns null for anything unrecognised, so a genuine bug still propagates and shows up as a
 * protocol error rather than being flattened into a misleading "check your credentials".
 */
export function mapRedditError(error: unknown, portalUrl: string, hint?: string): ToolTextResult | null {
  if (error instanceof MissingCredentialError) {
    return missingCredentialError(SERVER_SLUG, error.keyName, portalUrl);
  }

  if (error instanceof InvalidCredentialsError) {
    return toolError(
      `Reddit rejected the configured app credentials (HTTP ${error.status} from the token endpoint).`,
      `Check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET at ${portalUrl}/admin/servers/${SERVER_SLUG}. The app at ` +
        "https://old.reddit.com/prefs/apps must be a 'script' (or 'web app') type — an 'installed app' is a public " +
        "client and is issued no secret, which this grant requires.",
    );
  }

  if (error instanceof NoAccessTokenError) {
    return toolError(
      "Reddit's token endpoint accepted the credentials but returned no access token.",
      "This is an upstream fault rather than a configuration problem; retry shortly.",
    );
  }

  if (error instanceof MoreChildrenError) {
    return toolError(
      `Reddit rejected the comment expansion: ${error.detail}.`,
      "The comment ids may belong to a different post, or the cursor may be stale. Re-run reddit_get_post " +
        "to get fresh cursors, keeping `sort` the same across both calls.",
    );
  }

  if (error instanceof UnrecognisedPostReferenceError) {
    return toolError(`Could not read a Reddit post id from ${JSON.stringify(error.input)}.`, error.hint);
  }

  if (error instanceof InvalidSubredditError) {
    return toolError(
      `${JSON.stringify(error.input)} is not a valid subreddit name.`,
      "Pass the name without the 'r/' prefix, e.g. 'newzealand'. Use reddit_search_subreddits to find one.",
    );
  }

  if (error instanceof ForbiddenContentError) {
    return toolError(
      "Reddit returned 403 for that request even though this server is authenticated.",
      "That normally means the subreddit is private, quarantined, or banned, rather than that anything is wrong " +
        "with the request. An app-only token cannot see private communities or opt in to quarantined ones.",
    );
  }

  if (error instanceof UpstreamHttpError) {
    if (error.response.status === 404) {
      return toolError(
        "Reddit returned 404 — no such post or subreddit.",
        hint ?? "Check the spelling, or find it with reddit_search_subreddits or reddit_search_posts.",
      );
    }
    if (error.response.status === 429) {
      return toolError(
        "Reddit rate-limited this request.",
        "Reddit allows 60 requests per minute for the whole app. Wait a moment and retry, or make the request " +
          "smaller: a lower `limit`, a lower `depth`, or fewer ids per reddit_get_more_comments call.",
      );
    }
    return upstreamError(error.source, error.response, hint);
  }

  return null;
}

/** Cursor pagination, which is what Reddit does — there is no offset and no total to report. */
export const cursorParam = z
  .string()
  .optional()
  .describe(
    "Pass the `next_cursor` from a previous call to fetch the next page. Reddit paginates by an opaque `after` " +
      "fullname rather than a numeric offset, reports no total count, and stops serving results past roughly " +
      "1,000 items however far you page — narrow the query rather than paging deep.",
  );

export const includeNsfwParam = z
  .boolean()
  .default(false)
  .describe(
    "Include results marked over-18. Defaults to false. This affects search and listings only — reading a " +
      "specific NSFW post by id or URL with reddit_get_post always works.",
  );

/** Fields shared by every post row this server returns. */
export const postSchema = z.object({
  id: z.string(),
  fullname: z.string(),
  title: z.string(),
  author: z.string(),
  subreddit: z.string(),
  created_utc: z.number(),
  created_iso: z.string(),
  age: z.string(),
  /** Net upvotes minus downvotes. See VOTE_DATA_NOTE — raw up/down counts do not exist. */
  score: z.number(),
  upvote_ratio: z.number().optional(),
  num_comments: z.number(),
  permalink: z.string(),
  url: z.string().optional(),
  is_self: z.boolean(),
  over_18: z.boolean(),
  spoiler: z.boolean(),
  locked: z.boolean(),
  stickied: z.boolean(),
  archived: z.boolean(),
  flair: z.string().optional(),
  selftext_snippet: z.string().optional(),
});

/**
 * A comment, flattened.
 *
 * Nesting lives in `depth` and `parent_id` rather than in a recursive `replies` array. A
 * self-referential Zod schema would have to be `z.lazy`, which the MCP SDK converts into
 * `$ref`/`$defs` JSON Schema that not every client handles well — and a flat list is easier for a
 * code-execution harness to filter and group anyway. The readable nesting is in the markdown half.
 */
export const commentSchema = z.object({
  id: z.string(),
  fullname: z.string(),
  parent_id: z.string().nullable(),
  author: z.string(),
  body: z.string(),
  score: z.number().nullable(),
  created_utc: z.number(),
  age: z.string(),
  depth: z.number(),
  is_op: z.boolean(),
  stickied: z.boolean(),
  distinguished: z.string().nullable(),
  collapsed: z.boolean(),
  removed: z.boolean(),
  deleted: z.boolean(),
});

export const moreCursorSchema = z.object({
  kind: z.enum(["expandable", "continue_thread"]),
  child_ids: z.array(z.string()),
  count: z.number(),
  parent_comment_id: z.string().nullable(),
  reason: z.enum(["upstream", "depth_limit", "char_budget", "top_level_limit"]),
});

export { VOTE_DATA_NOTE };
