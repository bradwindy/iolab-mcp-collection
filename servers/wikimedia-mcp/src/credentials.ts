import { getCredential } from "@iolab/credentials";
import { SERVER_SLUG, WIKIMEDIA_OAUTH_TOKEN } from "./constants.js";

/**
 * Wikimedia's 2026 rate limits (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits) give an
 * unauthenticated client with a policy-compliant User-Agent 200 requests/minute, and an
 * authenticated one up to 2,000 — plus Action API concurrency 3 instead of 1 per
 * https://wikitech.wikimedia.org/wiki/Robot_policy. 200/min is already far beyond what an
 * interactive LLM session needs, so this token is genuinely optional: every tool must work fully
 * without it, and this helper never throws — it returns `null` when unset, and the request builder
 * in clients/http.ts omits the Authorization header entirely in that case.
 *
 * Not verified against a real token: per docs/ADDING_A_SERVER.md §2 no agent may register a
 * consumer or obtain a key, so the Bearer path is written defensively against the documented
 * OAuth 2.0 scheme (https://www.mediawiki.org/wiki/OAuth/For_Developers) and stays unexercised
 * until the operator enters one via the portal.
 */
export async function getOptionalWikimediaToken(env: Env): Promise<string | null> {
  const token = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, WIKIMEDIA_OAUTH_TOKEN, env.ENCRYPTION_KEY);
  return token && token.length > 0 ? token : null;
}
