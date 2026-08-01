import { getCredential } from "@iolab/credentials";
import { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, SERVER_SLUG } from "./constants.js";

export type RedditCredentialName = typeof REDDIT_CLIENT_ID | typeof REDDIT_CLIENT_SECRET | typeof REDDIT_USERNAME;

/** Thrown when a required upstream credential has not been configured yet for this server. */
export class MissingCredentialError extends Error {
  constructor(public readonly keyName: RedditCredentialName) {
    super(`Missing credential: ${keyName}`);
    this.name = "MissingCredentialError";
  }
}

/**
 * Thrown when Reddit itself rejects the configured client id/secret pair.
 *
 * Deliberately distinct from `UpstreamHttpError`: a 401 from the token endpoint means the stored
 * credentials are wrong (or the app was deleted), which is a configuration problem the operator can
 * fix, not the transient upstream failure that `upstreamError`'s "this may be transient, retry"
 * hint would wrongly imply.
 */
export class InvalidCredentialsError extends Error {
  constructor(public readonly status: number) {
    super(`Reddit rejected the configured client credentials (HTTP ${status})`);
    this.name = "InvalidCredentialsError";
  }
}

/** The three values every request needs: the app's id and secret, plus the username for the User-Agent. */
export type RedditCredentials = {
  clientId: string;
  clientSecret: string;
  username: string;
};

async function require1(env: Env, keyName: RedditCredentialName): Promise<string> {
  const value = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, keyName, env.ENCRYPTION_KEY);
  if (!value) throw new MissingCredentialError(keyName);
  return value;
}

/**
 * Fetch and decrypt the Reddit app credentials from the shared credentials store.
 *
 * All three are required, and there is no anonymous fallback to degrade to: Reddit returns 403 for
 * every unauthenticated API request (verified live), and a generic or username-less User-Agent is
 * throttled or blocked outright by its own documented rules. Throws MissingCredentialError — caught
 * by tool handlers and mapped to an actionable missing-credential error naming the specific key.
 *
 * Read serially rather than with Promise.all so the error names the *first* missing key in a stable
 * order, which makes the portal form fillable one field at a time instead of reporting whichever
 * D1 read happened to reject first.
 */
export async function requireRedditCredentials(env: Env): Promise<RedditCredentials> {
  const clientId = await require1(env, REDDIT_CLIENT_ID);
  const clientSecret = await require1(env, REDDIT_CLIENT_SECRET);
  const username = await require1(env, REDDIT_USERNAME);
  return { clientId, clientSecret, username };
}
