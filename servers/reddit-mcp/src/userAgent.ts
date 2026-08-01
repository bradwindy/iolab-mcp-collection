/**
 * Reddit's API rules require a unique, descriptive User-Agent in the shape
 * `<platform>:<app id>:<version string> (by /u/<reddit username>)`, and state that many default
 * library User-Agents "are drastically limited to encourage unique and descriptive user-agent
 * strings". Getting this wrong shows up as aggressive throttling or a flat block rather than as a
 * useful error, so it is built in one place and asserted in tests.
 *
 * The username comes from the credential store, not from source: this repo treats operator identity
 * as a secret (see BASE_DOMAIN and ACCESS_EMAIL in apps/gateway), and a Reddit handle committed to a
 * public repo is exactly that.
 */
const PLATFORM = "cloudflare-workers";
const APP_ID = "iolab-reddit-mcp";
const VERSION = "v0.1.0";

/**
 * Reduce a pasted username to the legal Reddit handle it starts with.
 *
 * Two jobs. It drops a leading `u/` or `/u/`, because an operator pasting their profile URL would
 * otherwise produce `(by /u//u/name)` — exactly the kind of malformed identifier Reddit throttles.
 * And it **truncates at** the first character outside Reddit's own `[A-Za-z0-9_-]` handle alphabet
 * rather than deleting illegal characters and closing the gap: a stray CR or LF here would be a
 * header-injection vector, and stripping-and-joining would silently weld `brad\r\nley: evil` into
 * the plausible-looking `bradleyevil`. Truncating fails visibly instead.
 */
export function normaliseUsername(raw: string): string {
  const withoutPrefix = raw.trim().replace(/^\/?u\//i, "");
  return /^[A-Za-z0-9_-]*/.exec(withoutPrefix)?.[0] ?? "";
}

/** The one User-Agent every request from this server sends. */
export function userAgent(username: string): string {
  const handle = normaliseUsername(username);
  return `${PLATFORM}:${APP_ID}:${VERSION} (by /u/${handle})`;
}
