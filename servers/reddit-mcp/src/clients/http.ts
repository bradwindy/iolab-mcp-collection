import { fetchWithBackoff, UpstreamHttpError } from "@iolab/mcp-kit";
import { getAccessToken } from "../auth.js";
import { REDDIT_API_BASE, UPSTREAM_NAME } from "../constants.js";
import { requireRedditCredentials, type RedditCredentials } from "../credentials.js";
import { userAgent } from "../userAgent.js";

/**
 * Thrown when Reddit returns 403 on a *data* request (as opposed to the token mint, which raises
 * InvalidCredentialsError). With a valid token, 403 means the content is out of reach rather than
 * that the client is unauthenticated: private, quarantined, or banned subreddits all answer this
 * way. Mapped by handlers to a message that says so, because the generic
 * "returned HTTP 403, this may be transient" would send the caller retrying forever.
 */
export class ForbiddenContentError extends Error {
  constructor(public readonly path: string) {
    super(`Reddit returned 403 for ${path}`);
    this.name = "ForbiddenContentError";
  }
}

/** Everything a request needs beyond the URL: resolved credentials, reused across calls in one handler. */
export type RedditSession = {
  creds: RedditCredentials;
};

/** Resolve credentials once per tool invocation rather than once per upstream call. */
export async function openSession(env: Env): Promise<RedditSession> {
  return { creds: await requireRedditCredentials(env) };
}

function buildUrl(path: string, params: Record<string, string | number | boolean | undefined>): URL {
  const url = new URL(path, REDDIT_API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  // Without raw_json=1 Reddit HTML-escapes every `&`, `<` and `>` in selftext and comment bodies,
  // so text arrives full of `&amp;` and `&gt;`. Set here rather than by callers because forgetting
  // it corrupts output silently — nothing errors, the text is just subtly wrong.
  url.searchParams.set("raw_json", "1");
  return url;
}

async function authorisedFetch(session: RedditSession, env: Env, url: URL, forceRefresh: boolean): Promise<Response> {
  const token = await getAccessToken(env, session.creds, forceRefresh);
  return fetchWithBackoff(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent(session.creds.username),
    },
  } satisfies RequestInit);
}

/**
 * The one request helper every Reddit client call goes through.
 *
 * Adds the bearer token, the mandatory User-Agent, and `raw_json=1`; retries via
 * `fetchWithBackoff`, whose default `retryOn` already covers 429 and 5xx and honours `Retry-After`
 * — which is how Reddit signals a rate-limit breach, alongside the `X-Ratelimit-*` headers.
 *
 * A 401 means the cached token expired or was revoked mid-flight. It is retried exactly once with a
 * freshly minted token; the `forceRefresh` flag is passed positionally rather than tracked in a
 * loop so a second 401 cannot re-enter the refresh path and spin.
 */
export async function redditGet<T>(
  session: RedditSession,
  env: Env,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  const url = buildUrl(path, params);

  let response = await authorisedFetch(session, env, url, false);
  if (response.status === 401) {
    response = await authorisedFetch(session, env, url, true);
  }

  if (response.status === 403) throw new ForbiddenContentError(path);
  if (!response.ok) throw new UpstreamHttpError(UPSTREAM_NAME, response);

  return (await response.json()) as T;
}

/**
 * Run upstream calls one at a time.
 *
 * Reddit's API rules cap an OAuth2 client at 60 requests per minute for the whole app — not per
 * connection — so a `Promise.all` fan-out is the shape most likely to earn a 429 and is actively
 * wrong here. Anything needing more than one upstream call (notably morechildren batching) routes
 * through this instead. Same reasoning, and same helper, as wikimedia-mcp's `serially`.
 */
export async function serially<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = [];
  for (const task of tasks) {
    results.push(await task());
  }
  return results;
}
