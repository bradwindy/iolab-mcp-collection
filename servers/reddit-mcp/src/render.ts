import type { MoreCursor, TreeComment } from "./comments.js";
import { REDDIT_WEB_BASE } from "./constants.js";
import { relativeAge } from "./time.js";
import type { PostData, SubredditData } from "./types.js";

/**
 * The sentence that keeps a model from inventing vote counts.
 *
 * Reddit fuzzes `ups` to mirror `score` and pins `downs` to 0, so there is no endpoint that returns
 * real upvote and downvote totals. This appears in the rendered footer *and* in the tool
 * descriptions, deliberately in both, because a model that reads only one of them still sees it.
 */
export const VOTE_DATA_NOTE =
  "Reddit does not expose upvote and downvote counts — they are deliberately fuzzed. Only the net `score` " +
  "(and `upvote_ratio` on posts) is real; do not infer or state raw vote totals.";

/** Normalise text that will be embedded in markdown without being escaped. */
function normaliseBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    // Zero-width space/non-joiner/joiner and the BOM. Reddit comments pick these up from copy-paste
    // and from users evading automod word filters; they are invisible but cost tokens.
    // Alternation rather than a character class: a class containing the zero-width joiner trips
    // eslint's no-misleading-character-class, since \u200D is what fuses emoji sequences.
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max).trimEnd()}\n\n…[truncated at ${max} of ${text.length} characters]`, truncated: true };
}

/**
 * Indent every line of a body to sit under its bullet.
 *
 * Load-bearing, not cosmetic: Reddit comment bodies *are* markdown, so an un-indented body
 * containing its own heading, list, blockquote or fenced code block terminates the enclosing list
 * and collapses the whole thread's structure. Bodies are never escaped, because escaping would
 * ruin exactly those constructs — indenting preserves them instead.
 */
function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${pad}${line}`))
    .join("\n");
}

function score(value: number | null): string {
  if (value === null) return "score hidden";
  return `${value.toLocaleString("en-NZ")} ${Math.abs(value) === 1 ? "pt" : "pts"}`;
}

function commentMarkers(comment: TreeComment): string[] {
  const markers: string[] = [];
  if (comment.is_op) markers.push("[OP]");
  if (comment.distinguished === "moderator") markers.push("[mod]");
  if (comment.distinguished === "admin") markers.push("[admin]");
  if (comment.stickied) markers.push("[stickied]");
  if (comment.collapsed) markers.push("[collapsed]");
  if (comment.edited) markers.push("[edited]");
  return markers;
}

function renderComment(comment: TreeComment, nowSeconds: number, maxCommentChars: number, out: string[]): void {
  const indent = " ".repeat(comment.depth * 2);
  const byline = [`**u/${comment.author}**`, score(comment.score), relativeAge(comment.created_utc, nowSeconds), ...commentMarkers(comment)].join(
    " · ",
  );
  out.push(`${indent}- ${byline}`);

  const body = comment.removed
    ? "_[removed by moderators]_"
    : comment.deleted && comment.body === "[deleted]"
      ? "_[deleted by author]_"
      : truncate(normaliseBody(comment.body), maxCommentChars).text;

  if (body.length > 0) out.push(indentBlock(body, comment.depth * 2 + 2));

  for (const reply of comment.replies) renderComment(reply, nowSeconds, maxCommentChars, out);
}

function renderCursorLine(cursor: MoreCursor): string {
  if (cursor.kind === "continue_thread") {
    const parent = cursor.parent_comment_id ?? "the thread root";
    return (
      `- _[continue this thread]_ under \`${parent}\` (${cursor.count} more) — not expandable here; ` +
      `call \`reddit_get_post\` with \`comment: "${parent}"\`.`
    );
  }
  const parent = cursor.parent_comment_id === null ? "top level" : `\`${cursor.parent_comment_id}\``;
  return `- ${cursor.count} more under ${parent} — \`reddit_get_more_comments\` with \`children: [${cursor.child_ids
    .slice(0, 3)
    .map((id) => `"${id}"`)
    .join(", ")}${cursor.child_ids.length > 3 ? ", …" : ""}]\``;
}

export type PostRenderOptions = {
  nowSeconds: number;
  maxPostChars: number;
  includeBody: boolean;
};

/** The post header: title, byline, flags, and the body or link target. */
export function renderPost(post: PostData, opts: PostRenderOptions): string {
  const lines: string[] = [`# ${post.title}`];

  const byline = [
    `r/${post.subreddit}`,
    `u/${post.author}`,
    relativeAge(post.created_utc, opts.nowSeconds),
    `${post.score.toLocaleString("en-NZ")} pts`,
    ...(typeof post.upvote_ratio === "number" ? [`${Math.round(post.upvote_ratio * 100)}% upvoted`] : []),
    `${post.num_comments.toLocaleString("en-NZ")} comments`,
  ];
  lines.push(byline.join(" · "));

  const markers: string[] = [];
  if (post.over_18) markers.push("[NSFW]");
  if (post.spoiler) markers.push("[spoiler]");
  if (post.locked) markers.push("[locked]");
  if (post.archived) markers.push("[archived]");
  if (post.stickied) markers.push("[stickied]");
  if (post.link_flair_text) markers.push(`Flair: ${post.link_flair_text}`);
  if (markers.length > 0) lines.push(markers.join(" · "));

  lines.push(`\`${post.name}\` · ${REDDIT_WEB_BASE}${post.permalink}`);

  if (opts.includeBody) {
    const selftext = normaliseBody(post.selftext ?? "");
    // A link post's payload is its target, not its (usually empty) selftext. Crossposts and
    // galleries frequently carry both, so this is additive rather than exclusive.
    if (post.is_self === false && post.url && post.url.length > 0) {
      lines.push("", `Link: ${post.url}`);
    }
    if (selftext.length > 0) {
      lines.push("", truncate(selftext, opts.maxPostChars).text);
    }
  }

  return lines.join("\n");
}

export type ThreadRenderOptions = {
  nowSeconds: number;
  maxCommentChars: number;
  sort: string;
  maxDepth: number;
  /** Total comments Reddit says the post has, for an honest "N of M" line. */
  totalComments: number;
  shownComments: number;
};

/** The comment thread: an indented bullet tree, then a footer naming every unexpanded branch. */
export function renderThread(comments: TreeComment[], cursors: MoreCursor[], opts: ThreadRenderOptions): string {
  const out: string[] = [
    "---",
    "",
    `## Comments — ${opts.shownComments.toLocaleString("en-NZ")} of ${opts.totalComments.toLocaleString("en-NZ")} shown, sorted by "${opts.sort}", depth ≤ ${opts.maxDepth}`,
    "",
  ];

  if (comments.length === 0) {
    out.push("_No comments were returned. The post may have none, or they may all sit behind the cursors below._");
  }

  for (const comment of comments) renderComment(comment, opts.nowSeconds, opts.maxCommentChars, out);

  const withIds = cursors.filter((cursor) => cursor.kind === "expandable" || cursor.count > 0);
  if (withIds.length > 0) {
    out.push("", "---", "", `_${withIds.length} branch(es) not expanded:_`);
    for (const cursor of withIds) out.push(renderCursorLine(cursor));
  }

  out.push("", `_${VOTE_DATA_NOTE}_`);
  return out.join("\n");
}

/** One row per post, for search results and subreddit listings. */
export function renderPostList(posts: PostData[], nowSeconds: number, snippetChars: number): string {
  return posts
    .map((post, index) => {
      const byline = [
        `r/${post.subreddit}`,
        `u/${post.author}`,
        relativeAge(post.created_utc, nowSeconds),
        `${post.score.toLocaleString("en-NZ")} pts`,
        ...(typeof post.upvote_ratio === "number" ? [`${Math.round(post.upvote_ratio * 100)}%`] : []),
        `${post.num_comments.toLocaleString("en-NZ")} comments`,
        ...(post.link_flair_text ? [`Flair: ${post.link_flair_text}`] : []),
        ...(post.over_18 ? ["[NSFW]"] : []),
      ].join(" · ");

      const lines = [
        `${index + 1}. **${post.title}**`,
        `   ${byline}`,
        // The fullname is printed on every row precisely so the model can hand it straight to
        // reddit_get_post without re-parsing a URL.
        `   \`${post.name}\` · ${REDDIT_WEB_BASE}${post.permalink}`,
      ];

      const snippet = normaliseBody(post.selftext ?? "");
      if (snippet.length > 0 && snippetChars > 0) {
        const clipped = snippet.length > snippetChars ? `${snippet.slice(0, snippetChars).trimEnd()}…` : snippet;
        lines.push(indentBlock(`> ${clipped.replace(/\n+/g, " ")}`, 3));
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

/** One row per subreddit, for discovery results. */
export function renderSubredditList(subreddits: SubredditData[], nowSeconds: number): string {
  return subreddits
    .map((subreddit, index) => {
      const facts = [
        typeof subreddit.subscribers === "number" ? `${subreddit.subscribers.toLocaleString("en-NZ")} subscribers` : "subscriber count unavailable",
        ...(typeof subreddit.active_user_count === "number" ? [`${subreddit.active_user_count.toLocaleString("en-NZ")} online`] : []),
        ...(subreddit.subreddit_type ? [subreddit.subreddit_type] : []),
        ...(subreddit.over18 ? ["[NSFW]"] : []),
        ...(typeof subreddit.created_utc === "number" ? [`created ${relativeAge(subreddit.created_utc, nowSeconds)}`] : []),
      ].join(" · ");

      const lines = [`${index + 1}. **r/${subreddit.display_name}** — ${subreddit.title ?? ""}`.trimEnd(), `   ${facts}`];
      const description = normaliseBody(subreddit.public_description ?? "");
      if (description.length > 0) lines.push(indentBlock(`> ${description.replace(/\n+/g, " ")}`, 3));
      return lines.join("\n");
    })
    .join("\n\n");
}
