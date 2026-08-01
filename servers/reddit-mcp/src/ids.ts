/**
 * Normalising the many shapes a caller can name a Reddit post in.
 *
 * A model handed a Reddit link by a user will pass on whatever it was given, so all of these have
 * to work: a full desktop URL, an old.reddit or np.reddit variant, a `redd.it` short link, a share
 * link trailing `?utm_source=…`, a bare base36 id, or a `t3_`-prefixed fullname.
 */

/** Base36 and, in practice, 4–13 characters. Kept loose enough to survive Reddit lengthening ids. */
const BARE_ID = /^[a-z0-9]{4,16}$/i;

/**
 * Anchored on purpose. An unanchored `.endsWith("reddit.com")` check would accept
 * `reddit.com.evil.test`, and a subdomain wildcard without the anchor would accept
 * `notreddit.com` — both are the standard host-suffix spoofing shape.
 */
const REDDIT_HOST = /^(?:[a-z0-9-]+\.)*reddit\.com$/i;

/** What every accepted form reduces to. */
export type PostRef = {
  /** Bare base36 post id, no `t3_` prefix — what `/comments/{id}` wants. */
  postId: string;
  /** `t3_`-prefixed fullname, needed by `/api/morechildren`'s `link_id`. */
  fullname: string;
  /** Set when the caller passed a permalink pointing at one comment rather than the post. */
  commentId: string | null;
};

/** Thrown when a caller's `post` argument cannot be resolved to a post id. */
export class UnrecognisedPostReferenceError extends Error {
  constructor(
    public readonly input: string,
    public readonly hint: string,
  ) {
    super(`Could not read a Reddit post id from ${JSON.stringify(input)}`);
    this.name = "UnrecognisedPostReferenceError";
  }
}

/** Thrown when a subreddit name is not a legal subreddit name. */
export class InvalidSubredditError extends Error {
  constructor(public readonly input: string) {
    super(`Not a valid subreddit name: ${JSON.stringify(input)}`);
    this.name = "InvalidSubredditError";
  }
}

const ACCEPTED_FORMS =
  "`post` accepts a post id (1abc2de), a fullname (t3_1abc2de), or any reddit.com permalink or URL " +
  "(https://www.reddit.com/r/sub/comments/1abc2de/slug/, old.reddit.com, or https://redd.it/1abc2de).";

function ref(postId: string, commentId: string | null): PostRef {
  return { postId, fullname: `t3_${postId}`, commentId };
}

function parseAsUrl(input: string): URL | null {
  try {
    // Accept protocol-relative and bare-host pastes like `reddit.com/r/x/comments/abc/`, and
    // leading-slash permalinks like `/r/x/comments/abc/`, which Reddit's own JSON uses.
    if (input.startsWith("/")) return new URL(`https://www.reddit.com${input}`);
    if (input.startsWith("http://") || input.startsWith("https://")) return new URL(input);
    return new URL(`https://${input}`);
  } catch {
    return null;
  }
}

/** Reduce any accepted reference to a post id, and a comment id when the link named one. */
export function normalisePostId(raw: string): PostRef {
  const input = raw.trim();
  if (input.length === 0) throw new UnrecognisedPostReferenceError(raw, ACCEPTED_FORMS);

  // `t3_abc123` — a fullname. A `t1_` comment fullname is rejected explicitly rather than silently
  // treated as a post, which would 404 confusingly.
  const fullname = /^t(\d)_([a-z0-9]+)$/i.exec(input);
  if (fullname) {
    const [, kind, id] = fullname;
    if (kind !== "3" || id === undefined) {
      throw new UnrecognisedPostReferenceError(
        raw,
        kind === "1"
          ? "That is a comment fullname (t1_…), not a post. Pass the post it belongs to, and use `comment` to focus on that reply."
          : ACCEPTED_FORMS,
      );
    }
    return ref(id.toLowerCase(), null);
  }

  if (!input.includes("/") && !input.includes(".") && BARE_ID.test(input)) {
    return ref(input.toLowerCase(), null);
  }

  const url = parseAsUrl(input);
  if (!url) throw new UnrecognisedPostReferenceError(raw, ACCEPTED_FORMS);

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  // https://redd.it/abc123 — the short-link form; the id is the whole path.
  if (host === "redd.it") {
    const id = segments[0];
    if (id !== undefined && BARE_ID.test(id)) return ref(id.toLowerCase(), null);
    throw new UnrecognisedPostReferenceError(raw, ACCEPTED_FORMS);
  }

  if (!REDDIT_HOST.test(host)) throw new UnrecognisedPostReferenceError(raw, ACCEPTED_FORMS);

  // The mobile share link. It is an opaque server-side redirect carrying no post id, so it cannot
  // be resolved here without following it — and www.reddit.com 403s API traffic. Say so precisely
  // rather than failing with a generic parse error the caller cannot act on.
  // The path is /r/{sub}/s/{code}, so `r` sits two segments before `s`, not one.
  const shareIndex = segments.findIndex((segment) => segment.toLowerCase() === "s");
  if (shareIndex >= 2 && segments[shareIndex - 2]?.toLowerCase() === "r" && segments.length > shareIndex + 1) {
    throw new UnrecognisedPostReferenceError(
      raw,
      "That is a Reddit mobile share link (/r/<sub>/s/…), which is an opaque redirect this server cannot resolve. " +
        "Open it in a browser and pass the canonical URL it lands on, or pass the post id directly.",
    );
  }

  // /r/{sub}/comments/{id}/{slug}/{commentId}, /comments/{id}, and /user/{name}/comments/{id} all
  // occur. The segment after `comments` is the post; a further segment past the slug is a comment.
  const commentsIndex = segments.indexOf("comments");
  if (commentsIndex !== -1) {
    const postId = segments[commentsIndex + 1];
    if (postId !== undefined && BARE_ID.test(postId)) {
      const focused = segments[commentsIndex + 3];
      const commentId = focused !== undefined && BARE_ID.test(focused) ? focused.toLowerCase() : null;
      return ref(postId.toLowerCase(), commentId);
    }
  }

  throw new UnrecognisedPostReferenceError(raw, ACCEPTED_FORMS);
}

/**
 * Reduce `r/foo`, `/r/foo`, `https://www.reddit.com/r/foo/` or `foo` to `foo`.
 *
 * Multireddit syntax (`a+b+c`) and the special `all` / `popular` feeds are legal listing targets
 * and are passed through.
 */
export function normaliseSubreddit(raw: string): string {
  let candidate = raw.trim();

  if (candidate.includes("/")) {
    const segments = candidate
      .replace(/^https?:\/\//i, "")
      .split("/")
      .filter((segment) => segment.length > 0);
    const index = segments.findIndex((segment) => segment.toLowerCase() === "r");
    const afterR = index === -1 ? undefined : segments[index + 1];
    candidate = afterR ?? segments[segments.length - 1] ?? "";
  }

  candidate = candidate.replace(/^\/?r\//i, "").trim();

  // 2–21 characters is Reddit's own range; `+` allows multireddits and `_` allows `u_` profile subs.
  if (!/^[A-Za-z0-9_]{2,21}(?:\+[A-Za-z0-9_]{2,21})*$/.test(candidate)) throw new InvalidSubredditError(raw);
  return candidate;
}

/**
 * Encode a validated subreddit name for use as a URL path segment.
 *
 * `encodeURIComponent` alone is wrong here: it percent-encodes the `+` that separates the parts of
 * a multireddit, and `/r/a%2Bb/hot` is not a route Reddit serves. Each part is encoded separately
 * and rejoined with a literal `+`. The parts are already restricted to `[A-Za-z0-9_]` by
 * `normaliseSubreddit`, so the encoding is belt-and-braces rather than the only thing standing
 * between a caller and path traversal.
 */
export function subredditPath(name: string): string {
  return name
    .split("+")
    .map((part) => encodeURIComponent(part))
    .join("+");
}

/**
 * Bare comment id (no `t1_`), for the `comment` focus parameter and for morechildren id lists.
 *
 * Deliberately looser than `BARE_ID`: a post reference competes with free text a caller might have
 * typed (a subreddit name, a search phrase), so a 4-character floor there is a useful guard. Comment
 * ids arrive from cursors this server itself emitted, so the same floor would only reject
 * legitimately short ids from Reddit's early years for no benefit.
 */
const COMMENT_ID = /^[a-z0-9]{1,16}$/i;

export function normaliseCommentId(raw: string): string {
  const input = raw.trim();
  const fullname = /^t1_([a-z0-9]+)$/i.exec(input);
  const captured = fullname?.[1];
  if (captured !== undefined) return captured.toLowerCase();
  if (COMMENT_ID.test(input)) return input.toLowerCase();
  throw new UnrecognisedPostReferenceError(raw, "`comment` accepts a comment id (h9k2j1a) or a fullname (t1_h9k2j1a).");
}
