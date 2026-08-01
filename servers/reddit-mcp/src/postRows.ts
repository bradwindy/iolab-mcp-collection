import { relativeAge, toIso } from "./time.js";
import type { Listing, PostData, PostThing } from "./types.js";

/** The normalised post row both search and listing tools return. */
export type PostRow = {
  id: string;
  fullname: string;
  title: string;
  author: string;
  subreddit: string;
  created_utc: number;
  created_iso: string;
  age: string;
  score: number;
  upvote_ratio?: number;
  num_comments: number;
  permalink: string;
  url?: string;
  is_self: boolean;
  over_18: boolean;
  spoiler: boolean;
  locked: boolean;
  stickied: boolean;
  archived: boolean;
  flair?: string;
  selftext_snippet?: string;
};

/**
 * Optional fields are spread conditionally rather than set to `undefined`, because the repo compiles
 * with `exactOptionalPropertyTypes` — `{ flair: undefined }` is not assignable to `{ flair?: string }`.
 */
export function toPostRow(post: PostData, nowSeconds: number, snippetChars: number): PostRow {
  const snippet = (post.selftext ?? "").trim();
  return {
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
    ...(snippet.length > 0 && snippetChars > 0
      ? { selftext_snippet: snippet.length > snippetChars ? `${snippet.slice(0, snippetChars).trimEnd()}…` : snippet }
      : {}),
  };
}

export type FilteredListing = {
  posts: PostData[];
  /** How many rows this page dropped for being over-18, so the notice can be honest. */
  nsfwFiltered: number;
  nextCursor: string | null;
};

/**
 * Split a Listing into visible posts plus a cursor.
 *
 * NSFW filtering is done client-side even though the search and subreddit-search endpoints also
 * take `include_over_18`: that parameter's behaviour for app-only tokens is not something this
 * server can verify, and a listing endpoint like `/r/{sub}/hot` has no such parameter at all. The
 * client-side pass is the load-bearing half and works identically everywhere.
 *
 * `nextCursor` comes from Reddit's own `after`, never from the filtered count, so paging stays
 * correct even when a page returns fewer rows than `limit` because NSFW rows were dropped.
 */
export function filterListing(listing: Listing<PostThing>, includeNsfw: boolean): FilteredListing {
  const all = (listing.data?.children ?? []).filter((child) => child.kind === "t3").map((child) => child.data);
  const posts = includeNsfw ? all : all.filter((post) => post.over_18 !== true);
  return {
    posts,
    nsfwFiltered: all.length - posts.length,
    nextCursor: listing.data?.after ?? null,
  };
}
