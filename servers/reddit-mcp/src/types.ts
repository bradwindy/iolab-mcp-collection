/**
 * Structural types for the slice of Reddit's JSON API this server reads.
 *
 * Only the fields actually used are declared. Everything is optional at the boundary: Reddit's
 * responses vary by post type (self / link / gallery / crosspost), by whether content was deleted,
 * and by whether the caller is allowed to see a given field, and a missing field must degrade to a
 * gap in the output rather than a crash.
 */

/** Reddit's type prefixes. `t1` = comment, `t3` = link (post). */
export type Fullname = string;

export type Listing<T> = {
  kind: "Listing";
  data: {
    children: T[];
    after?: string | null;
    before?: string | null;
    dist?: number | null;
  };
};

export type PostData = {
  id: string;
  name: Fullname;
  title: string;
  author: string;
  subreddit: string;
  subreddit_name_prefixed?: string;
  permalink: string;
  url?: string;
  selftext?: string;
  is_self?: boolean;
  is_video?: boolean;
  post_hint?: string;
  /**
   * Net upvotes minus downvotes. Reddit does not expose true up/down counts: `ups` merely mirrors
   * `score` and `downs` is always 0, both fuzzed deliberately as an anti-manipulation measure. This
   * server therefore returns `score` and `upvote_ratio` only, and never derives a "total votes".
   */
  score: number;
  upvote_ratio?: number;
  num_comments: number;
  created_utc: number;
  edited?: number | boolean;
  over_18?: boolean;
  spoiler?: boolean;
  locked?: boolean;
  archived?: boolean;
  stickied?: boolean;
  distinguished?: string | null;
  link_flair_text?: string | null;
  removed_by_category?: string | null;
  crosspost_parent?: string | null;
  num_crossposts?: number;
};

export type CommentData = {
  id: string;
  name: Fullname;
  author: string;
  body?: string;
  score?: number;
  /** Reddit hides a comment's score for the first hour or so after posting. */
  score_hidden?: boolean;
  created_utc: number;
  edited?: number | boolean;
  depth?: number;
  parent_id?: Fullname;
  link_id?: Fullname;
  stickied?: boolean;
  distinguished?: string | null;
  is_submitter?: boolean;
  collapsed?: boolean;
  /**
   * A Listing of replies, or the empty string when there are none. Reddit really does return `""`
   * here rather than null or an empty Listing, and assuming an object is the classic crash in
   * comment-tree code.
   */
  replies?: Listing<CommentThing> | "" | null;
};

/**
 * The "load more comments" placeholder Reddit substitutes for a truncated branch.
 *
 * Two distinct meanings share this kind, and conflating them produces empty results:
 *  - `children` non-empty: real comment ids, expandable via `/api/morechildren`.
 *  - `count: 0` with `id: "_"`: a *continue this thread* marker for a branch deeper than the
 *    requested depth. It carries no ids and morechildren cannot expand it; only a fresh
 *    `/comments/{post}?comment={parent}` call reaches that subtree.
 */
export type MoreData = {
  id: string;
  name?: Fullname;
  parent_id?: Fullname;
  depth?: number;
  count: number;
  children: string[];
};

export type PostThing = { kind: "t3"; data: PostData };
export type CommentThing = { kind: "t1"; data: CommentData } | { kind: "more"; data: MoreData };

/** `GET /comments/{id}` answers with exactly two Listings: the post, then its comment forest. */
export type CommentsResponse = [Listing<PostThing>, Listing<CommentThing>];

/** `/api/morechildren` answers with a flat array of things, not a tree. */
export type MoreChildrenResponse = {
  json?: {
    errors?: unknown[];
    data?: { things?: CommentThing[] };
  };
};

export type SubredditData = {
  display_name: string;
  display_name_prefixed?: string;
  title?: string;
  public_description?: string;
  subscribers?: number | null;
  active_user_count?: number | null;
  created_utc?: number;
  over18?: boolean;
  subreddit_type?: string;
  url?: string;
};

export type SubredditThing = { kind: "t5"; data: SubredditData };
