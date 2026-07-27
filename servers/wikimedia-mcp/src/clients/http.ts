import { fetchWithBackoff } from "@iolab/mcp-kit";
import { getOptionalWikimediaToken } from "../credentials.js";

/**
 * The Wikimedia Foundation User-Agent Policy
 * (https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy) requires a
 * descriptive client name plus contact information, and since September 2025 this is enforced at
 * the CDN edge rather than merely requested: confirmed live that a library-default User-Agent
 * (`python-requests/2.31.0`) gets a flat **403 from HAProxy** before MediaWiki ever sees the
 * request, while this string returns 200. It is also worth 20x the throughput — an "unidentified"
 * client is capped at 10 requests/minute against 200 for a compliant one
 * (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits).
 *
 * Centralised here so every client sends the same one rather than each hand-rolling it.
 */
export const USER_AGENT = "iolab-mcp-collection/wikimedia-mcp (+https://github.com/bradwindy/iolab-mcp-collection)";

/**
 * The one fetch wrapper every client in this server uses: adds the mandatory User-Agent, the
 * optional OAuth 2.0 Bearer token when one is configured (see credentials.ts — every tool must
 * work identically without it), and `fetchWithBackoff`'s retry/backoff, whose default `retryOn`
 * covers 429 and 5xx and honours `Retry-After` — which is exactly how Wikimedia signals a
 * rate-limit breach.
 *
 * Always GET: Wikimedia's API:Etiquette asks clients to prefer GET because POSTs are not cacheable.
 */
export async function wikimediaFetch(env: Env, url: string | URL, init: RequestInit = {}): Promise<Response> {
  const token = await getOptionalWikimediaToken(env);
  const headers = new Headers(init.headers);
  headers.set("User-Agent", USER_AGENT);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetchWithBackoff(url, { ...init, headers });
}

/**
 * Run upstream calls one at a time.
 *
 * The Robot policy (https://wikitech.wikimedia.org/wiki/Robot_policy) caps an unauthenticated
 * client at **1 concurrent Action API request**, so the `Promise.all` fan-out used elsewhere in
 * this collection is actively wrong here — it is the shape most likely to earn a throttle. Any
 * handler needing more than one upstream call routes through this instead.
 */
export async function serially<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  const results: T[] = [];
  for (const task of tasks) {
    results.push(await task());
  }
  return results;
}
