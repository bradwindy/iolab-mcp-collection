import { MORECHILDREN_BATCH_SIZE } from "../constants.js";
import { subredditPath } from "../ids.js";
import type {
  CommentThing,
  CommentsResponse,
  Listing,
  MoreChildrenResponse,
  PostThing,
  SubredditThing,
} from "../types.js";
import { redditGet, serially, type RedditSession } from "./http.js";

/** Reddit reported a morechildren failure inside a 200 response's `json.errors` envelope. */
export class MoreChildrenError extends Error {
  constructor(public readonly detail: string) {
    super(`Reddit rejected the comment expansion: ${detail}`);
    this.name = "MoreChildrenError";
  }
}

export type SearchSort = "relevance" | "hot" | "top" | "new" | "comments";
export type TimeRange = "hour" | "day" | "week" | "month" | "year" | "all";
export type CommentSort = "confidence" | "top" | "new" | "controversial" | "old" | "qa";
export type ListingSort = "hot" | "new" | "top" | "rising";

/**
 * Search posts, either across all of Reddit or restricted to one subreddit.
 *
 * `include_over_18` is Reddit's own NSFW switch on this endpoint. It is left off unless the caller
 * opts in, which is why the parameter is threaded all the way down rather than defaulted here.
 */
export async function searchPosts(
  session: RedditSession,
  env: Env,
  params: {
    query: string;
    subreddit?: string;
    sort: SearchSort;
    time: TimeRange;
    limit: number;
    after?: string;
    includeNsfw: boolean;
  },
): Promise<Listing<PostThing>> {
  const path = params.subreddit ? `/r/${subredditPath(params.subreddit)}/search` : "/search";
  return redditGet<Listing<PostThing>>(session, env, path, {
    q: params.query,
    sort: params.sort,
    t: params.time,
    limit: params.limit,
    after: params.after,
    type: "link",
    include_over_18: params.includeNsfw ? "on" : "off",
    ...(params.subreddit ? { restrict_sr: "on" } : {}),
  });
}

/** Browse a subreddit's hot / new / top / rising listing. `t` only means anything for `top`. */
export async function listSubredditPosts(
  session: RedditSession,
  env: Env,
  params: { subreddit: string; sort: ListingSort; time: TimeRange; limit: number; after?: string },
): Promise<Listing<PostThing>> {
  return redditGet<Listing<PostThing>>(session, env, `/r/${subredditPath(params.subreddit)}/${params.sort}`, {
    limit: params.limit,
    after: params.after,
    ...(params.sort === "top" ? { t: params.time } : {}),
  });
}

/**
 * Fetch a post and its comment forest.
 *
 * `comment` focuses the response on one subtree, which is the only way to reach a branch behind a
 * *continue this thread* marker — those carry no ids for `/api/morechildren` to expand.
 */
export async function getPostWithComments(
  session: RedditSession,
  env: Env,
  params: { postId: string; sort: CommentSort; limit: number; depth: number; comment?: string },
): Promise<CommentsResponse> {
  return redditGet<CommentsResponse>(session, env, `/comments/${encodeURIComponent(params.postId)}`, {
    sort: params.sort,
    limit: params.limit,
    depth: params.depth,
    comment: params.comment,
    threaded: true,
  });
}

/**
 * Expand collapsed comment ids via `/api/morechildren`.
 *
 * Reddit caps `children` at 100 ids per call, so longer lists are chunked — serially, because the
 * app-wide 60 requests/minute budget makes a parallel fan-out the fastest route to a 429.
 *
 * The response is a *flat* list of things regardless of nesting; re-threading is the caller's job
 * (see src/comments.ts).
 */
export async function getMoreChildren(
  session: RedditSession,
  env: Env,
  params: { linkFullname: string; childIds: string[]; sort: CommentSort },
): Promise<CommentThing[]> {
  const batches: string[][] = [];
  for (let i = 0; i < params.childIds.length; i += MORECHILDREN_BATCH_SIZE) {
    batches.push(params.childIds.slice(i, i + MORECHILDREN_BATCH_SIZE));
  }

  const responses = await serially(
    batches.map(
      (batch) => () =>
        redditGet<MoreChildrenResponse>(session, env, "/api/morechildren", {
          link_id: params.linkFullname,
          children: batch.join(","),
          sort: params.sort,
          api_type: "json",
          limit_children: false,
        }),
    ),
  );

  // Reddit reports morechildren failures in a `json.errors` envelope with a 200 status, so an
  // ignored error here surfaces as "no comments came back" — which the handler would then explain
  // as deleted comments or a mismatched sort, both wrong and both un-actionable.
  for (const response of responses) {
    const errors = response.json?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new MoreChildrenError(JSON.stringify(errors));
    }
  }

  return responses.flatMap((response) => response.json?.data?.things ?? []);
}

/** Search subreddits by name and description. */
export async function searchSubreddits(
  session: RedditSession,
  env: Env,
  params: { query: string; limit: number; after?: string; includeNsfw: boolean },
): Promise<Listing<SubredditThing>> {
  return redditGet<Listing<SubredditThing>>(session, env, "/subreddits/search", {
    q: params.query,
    limit: params.limit,
    after: params.after,
    include_over_18: params.includeNsfw ? "on" : "off",
  });
}

/** Full metadata for one subreddit. */
export async function getSubredditAbout(session: RedditSession, env: Env, subreddit: string): Promise<SubredditThing> {
  return redditGet<SubredditThing>(session, env, `/r/${subredditPath(subreddit)}/about`, {});
}
