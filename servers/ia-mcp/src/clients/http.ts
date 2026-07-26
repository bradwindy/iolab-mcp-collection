import { fetchWithBackoff } from "@iolab/mcp-kit";
import { getOptionalIaS3Credentials } from "../credentials.js";

/**
 * archive.org's automated-access policy (https://archive.org/developers/bots.html) asks for a
 * descriptive User-Agent identifying the client. Centralised here so every client file sends the
 * same one rather than each hand-rolling it.
 */
const USER_AGENT = "iolab-mcp-collection/ia-mcp (+https://github.com/bradwindy/iolab-mcp-collection)";

/**
 * The one fetch wrapper every client in this server uses: adds the shared User-Agent, the
 * optional IA-S3 `Authorization` header when credentials are configured (see credentials.ts —
 * every tool must work identically without it), and `fetchWithBackoff`'s retry/backoff, whose
 * default `retryOn` already covers 429 and 5xx — exactly the CDX 503 throttling observed live.
 */
export async function iaFetch(env: Env, url: string | URL, init: RequestInit = {}): Promise<Response> {
  const creds = await getOptionalIaS3Credentials(env);
  const headers = new Headers(init.headers);
  headers.set("User-Agent", USER_AGENT);
  if (creds) headers.set("Authorization", `LOW ${creds.access}:${creds.secret}`);
  return fetchWithBackoff(url, { ...init, headers });
}
