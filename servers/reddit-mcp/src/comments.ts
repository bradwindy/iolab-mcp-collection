import type { CommentData, CommentThing, MoreData } from "./types.js";

/** One comment in the tree this server hands back, with its replies already attached. */
export type TreeComment = {
  id: string;
  fullname: string;
  /**
   * Bare id of the parent *comment*, or null when this comment replies directly to the post.
   *
   * Never the post's id: a top-level comment's upstream `parent_id` is the post's `t3_` fullname,
   * and reporting that here would make every top-level comment look like a reply to a sibling.
   */
  parent_id: string | null;
  author: string;
  body: string;
  /**
   * Net score, or null while Reddit is hiding it (roughly the first hour after posting).
   *
   * There is deliberately no up/down breakdown and no total-votes figure: Reddit fuzzes `ups` to
   * mirror `score` and pins `downs` to 0, so any "total votes" derived from them would be invented.
   */
  score: number | null;
  created_utc: number;
  edited: boolean;
  depth: number;
  is_op: boolean;
  stickied: boolean;
  distinguished: string | null;
  collapsed: boolean;
  /** Body is `[removed]` — taken down by a moderator. Replies usually survive. */
  removed: boolean;
  /** Author or body is `[deleted]` — taken down by its author. */
  deleted: boolean;
  replies: TreeComment[];
};

/** Why a branch stopped, which determines what the caller should do about it. */
export type CursorReason = "upstream" | "depth_limit" | "char_budget" | "top_level_limit";

/**
 * A branch that was not expanded, and how to reach it.
 *
 * `expandable` cursors carry real comment ids for `reddit_get_more_comments`. `continue_thread`
 * cursors do not — Reddit emits them for branches below the requested depth and they carry no ids
 * at all, so the only way in is a fresh `reddit_get_post` focused on `parent_comment_id`. Offering
 * the two interchangeably is how you end up calling morechildren with an empty id list and
 * reporting "no more comments" for a thread that has hundreds.
 */
export type MoreCursor = {
  kind: "expandable" | "continue_thread";
  /** Bare comment ids to hand to reddit_get_more_comments. Always empty for `continue_thread`. */
  child_ids: string[];
  /** How many comments are hidden here, as far as can be told. */
  count: number;
  /** The comment these hidden replies hang off, or null when they are further top-level comments. */
  parent_comment_id: string | null;
  reason: CursorReason;
};

export type BuildOptions = {
  /** Maximum reply nesting to walk. 0 returns top-level comments with no replies. */
  maxDepth: number;
  /** Maximum number of top-level comments to include. Replies are bounded by depth and budget. */
  maxTopLevel: number;
  /** Soft ceiling on total body characters, so one enormous thread cannot swamp the context. */
  maxChars: number;
};

export type BuildResult = {
  comments: TreeComment[];
  /** Every unexpanded branch encountered, in document order. */
  cursors: MoreCursor[];
  /** Comments actually returned, at every depth. */
  included: number;
  /** True when the character budget, rather than the caller's depth/limit, ended the walk. */
  truncatedByBudget: boolean;
};

function isMore(thing: CommentThing): thing is { kind: "more"; data: MoreData } {
  return thing.kind === "more";
}

function isComment(thing: CommentThing): thing is { kind: "t1"; data: CommentData } {
  return thing.kind === "t1";
}

/**
 * Reddit sends `""` for a comment with no replies — not null, not an empty Listing. Treating that
 * empty string as an object is the single most common crash in naive comment-tree code.
 */
function childrenOf(data: CommentData): CommentThing[] {
  const replies = data.replies;
  if (!replies || typeof replies === "string") return [];
  return replies.data?.children ?? [];
}

/** Strip the `t1_`/`t3_` prefix from a fullname, tolerating an already-bare id. */
export function bareId(fullname: string | undefined): string | null {
  if (!fullname) return null;
  const match = /^t\d_(.+)$/.exec(fullname);
  return match?.[1] ?? fullname;
}

/**
 * The parent *comment*, or null when the parent is the post itself.
 *
 * A top-level comment's `parent_id` is the post's `t3_` fullname, so naively stripping the prefix
 * would report the post id as if it were a sibling comment — making `parent_id` never null and
 * quietly breaking any attempt to rebuild the tree from the flattened output.
 */
function parentCommentId(fullname: string | undefined): string | null {
  if (!fullname) return null;
  return fullname.startsWith("t3_") ? null : bareId(fullname);
}

function cursorFromMore(data: MoreData, parentCommentId: string | null): MoreCursor {
  // Reddit marks "continue this thread" with id "_" and no children. The id is the reliable signal;
  // an expandable stub can also report count 0, but it always carries ids.
  const isContinue = data.id === "_" || data.children.length === 0;
  return {
    kind: isContinue ? "continue_thread" : "expandable",
    child_ids: isContinue ? [] : data.children,
    count: data.count ?? 0,
    parent_comment_id: parentCommentId,
    reason: "upstream",
  };
}

function toComment(data: CommentData, depth: number): TreeComment {
  const body = data.body ?? "";
  return {
    id: data.id,
    fullname: data.name ?? `t1_${data.id}`,
    parent_id: parentCommentId(data.parent_id),
    author: data.author ?? "[unknown]",
    // Deleted and removed comments arrive with the literal body "[deleted]" / "[removed]". They are
    // kept rather than dropped: a hole in a conversation is itself information, and omitting them
    // orphans their replies, which usually survive and often explain what was there.
    body,
    score: data.score_hidden === true || typeof data.score !== "number" ? null : data.score,
    created_utc: data.created_utc,
    edited: typeof data.edited === "number" ? true : data.edited === true,
    depth,
    is_op: data.is_submitter === true,
    stickied: data.stickied === true,
    distinguished: data.distinguished ?? null,
    collapsed: data.collapsed === true,
    removed: body === "[removed]",
    deleted: body === "[deleted]" || data.author === "[deleted]",
    replies: [],
  };
}

/**
 * Turn the comment Listing from `GET /comments/{id}` into a depth- and budget-limited tree, and
 * collect every branch that was left unexpanded.
 *
 * The walk is depth-first in Reddit's own ordering, so comments kept under a tight budget are the
 * ones the chosen sort put first rather than an arbitrary breadth-first slice. Every branch cut
 * short — by depth, by the top-level limit, or by the budget — produces a cursor carrying the ids
 * that were skipped, so truncation is always recoverable and the reported counts are honest.
 */
export function buildCommentTree(things: CommentThing[], opts: BuildOptions): BuildResult {
  const cursors: MoreCursor[] = [];
  let charsUsed = 0;
  let included = 0;
  let truncatedByBudget = false;

  /**
   * Record the tail of a sibling list that the walk stopped short of.
   *
   * Both the skipped comments *and* any `more` stub among them have to be carried into the cursor.
   * Reddit puts its "load more comments" stub at the end of each sibling list — precisely inside
   * this tail — so filtering to `t1` things alone would drop the very branch the caller most needs,
   * silently, while the tool claims nothing is dropped silently.
   */
  const skippedCursor = (skipped: CommentThing[], parent: string | null, reason: CursorReason): void => {
    const ids = skipped.filter(isComment).map((thing) => thing.data.id);
    let hidden = 0;

    for (const thing of skipped) {
      if (!isMore(thing)) continue;
      if (thing.data.id === "_" || thing.data.children.length === 0) {
        // A continue-thread marker cannot be folded into an expandable cursor; it needs its own.
        cursors.push(cursorFromMore(thing.data, parent));
        continue;
      }
      ids.push(...thing.data.children);
      hidden += Math.max(0, (thing.data.count ?? 0) - thing.data.children.length);
    }

    if (ids.length === 0) return;
    cursors.push({ kind: "expandable", child_ids: ids, count: ids.length + hidden, parent_comment_id: parent, reason });
  };

  const walk = (nodes: CommentThing[], depth: number, parentCommentId: string | null): TreeComment[] => {
    const out: TreeComment[] = [];
    // Reddit's own `limit` counts every comment in the thread, not top-level ones, so the caller's
    // limit is enforced here as well. It applies only at the top level; replies are bounded by
    // `maxDepth` and the character budget instead, so a limit of 5 does not also truncate to five
    // replies per comment.
    const limit = depth === 0 ? opts.maxTopLevel : Number.POSITIVE_INFINITY;

    for (const [index, thing] of nodes.entries()) {
      if (isMore(thing)) {
        cursors.push(cursorFromMore(thing.data, parentCommentId));
        continue;
      }

      if (out.length >= limit) {
        skippedCursor(nodes.slice(index), parentCommentId, "top_level_limit");
        break;
      }

      const comment = toComment(thing.data, depth);

      if (charsUsed + comment.body.length > opts.maxChars) {
        truncatedByBudget = true;
        skippedCursor(nodes.slice(index), parentCommentId, "char_budget");
        break;
      }

      charsUsed += comment.body.length;
      included += 1;

      const children = childrenOf(thing.data);
      if (depth < opts.maxDepth) {
        comment.replies = walk(children, depth + 1, comment.id);
      } else if (children.length > 0) {
        // Depth cap reached with replies still below. These are reachable only by a fresh focused
        // read, exactly like Reddit's own continue-thread markers, so they are reported as such.
        cursors.push({
          kind: "continue_thread",
          child_ids: [],
          count: children.filter(isComment).length,
          parent_comment_id: comment.id,
          reason: "depth_limit",
        });
      }

      out.push(comment);
    }

    return out;
  };

  const comments = walk(things, 0, null);
  return { comments, cursors, included, truncatedByBudget };
}

/**
 * Re-thread the flat array `/api/morechildren` returns.
 *
 * That endpoint answers with every requested comment at the same level regardless of nesting, each
 * carrying a `parent_id`. Comments whose parent is also in the batch are attached to it; the rest
 * become roots of the returned forest, since their parent is a comment the caller already holds.
 *
 * Deliberately two passes. Fusing them would misfile any comment that appears before its parent in
 * the array — which Reddit does emit — as a root.
 */
export function threadFlatComments(things: CommentThing[]): { comments: TreeComment[]; cursors: MoreCursor[] } {
  const byId = new Map<string, TreeComment>();
  const cursors: MoreCursor[] = [];
  const order: TreeComment[] = [];

  for (const thing of things) {
    if (isMore(thing)) {
      cursors.push(cursorFromMore(thing.data, bareId(thing.data.parent_id)));
      continue;
    }
    // Reddit's `depth` here is relative to the original tree, so it is kept as sent and only
    // recomputed for nodes whose parent is present in this same batch.
    const comment = toComment(thing.data, thing.data.depth ?? 0);
    byId.set(comment.id, comment);
    order.push(comment);
  }

  const roots: TreeComment[] = [];
  for (const comment of order) {
    const parent = comment.parent_id === null ? undefined : byId.get(comment.parent_id);
    if (parent) {
      comment.depth = parent.depth + 1;
      parent.replies.push(comment);
    } else {
      roots.push(comment);
    }
  }

  return { comments: roots, cursors };
}

/**
 * Apply a depth cap and a character budget to an already-built tree.
 *
 * `buildCommentTree` enforces both while walking Reddit's own nested response, but
 * `threadFlatComments` cannot: `/api/morechildren` returns a flat list, so nesting only exists once
 * every node has been created. This is the second pass that makes `depth` and `max_chars` mean the
 * same thing on `reddit_get_more_comments` as they do on `reddit_get_post` — without it those
 * parameters are accepted and silently ignored, and a 500-id expansion can render megabytes.
 *
 * Trimmed branches produce cursors on the same terms as the initial walk, so nothing is dropped
 * without a way back to it.
 */
export function trimTree(comments: TreeComment[], opts: { maxDepth: number; maxChars: number }): BuildResult {
  const cursors: MoreCursor[] = [];
  let charsUsed = 0;
  let included = 0;
  let truncatedByBudget = false;

  /**
   * `relativeDepth` is what the cap applies to; `node.depth` is left untouched so an expanded
   * branch still indents consistently with the tree it is being spliced back into. Conflating the
   * two would re-base every expansion at zero and flatten the nesting the caller asked for.
   */
  const visit = (nodes: TreeComment[], relativeDepth: number, parent: string | null): TreeComment[] => {
    const kept: TreeComment[] = [];

    for (const [index, node] of nodes.entries()) {
      if (charsUsed + node.body.length > opts.maxChars) {
        truncatedByBudget = true;
        const remaining = nodes.slice(index);
        cursors.push({
          kind: "expandable",
          child_ids: remaining.map((remainingNode) => remainingNode.id),
          count: remaining.length,
          parent_comment_id: parent,
          reason: "char_budget",
        });
        break;
      }

      charsUsed += node.body.length;
      included += 1;

      const trimmed: TreeComment = { ...node, replies: [] };
      if (relativeDepth < opts.maxDepth) {
        trimmed.replies = visit(node.replies, relativeDepth + 1, node.id);
      } else if (node.replies.length > 0) {
        cursors.push({
          kind: "continue_thread",
          child_ids: [],
          count: node.replies.length,
          parent_comment_id: node.id,
          reason: "depth_limit",
        });
      }

      kept.push(trimmed);
    }

    return kept;
  };

  const trimmedRoots = visit(comments, 0, null);
  return { comments: trimmedRoots, cursors, included, truncatedByBudget };
}

/** Total comments in a tree, at every depth. Used for truncation notices. */
export function countComments(comments: TreeComment[]): number {
  return comments.reduce((total, comment) => total + 1 + countComments(comment.replies), 0);
}

/** Depth-first flattening, for the structured half of a tool result. */
export function flattenComments(comments: TreeComment[]): Array<Omit<TreeComment, "replies">> {
  const out: Array<Omit<TreeComment, "replies">> = [];
  const visit = (nodes: TreeComment[]): void => {
    for (const node of nodes) {
      const { replies, ...rest } = node;
      out.push(rest);
      visit(replies);
    }
  };
  visit(comments);
  return out;
}
