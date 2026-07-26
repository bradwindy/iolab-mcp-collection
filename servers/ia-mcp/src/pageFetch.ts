import { CACHE_TTL, cached } from "@iolab/mcp-kit";
import { fetchArchivedPage } from "./clients/wayback.js";
import { extractFromHtml } from "./htmlText.js";

// A timestamp far enough in the future that Wayback's "nearest capture at or before" resolution
// always lands on the true latest capture — used when a caller omits `timestamp`.
export const LATEST_SENTINEL = "99991231235959";

/**
 * Fetches an archived capture and extracts text/markdown/links from it, cached by the
 * *requested* timestamp+url. A capture at a specific timestamp is immutable, so a long TTL is
 * correct and materially reduces the CDX/Wayback load that produced 503s in testing — shared by
 * every tool that reads page content (read_page, diff_captures) so a page fetched once is reused.
 */
export async function fetchAndExtractPage(env: Env, url: string, requestedTimestamp: string) {
  const cacheKey = `ia:page:${requestedTimestamp}:${url}`;
  return cached(env.MCP_CACHE, cacheKey, CACHE_TTL.METADATA, async () => {
    // Confirmed live: the `id_` modifier always 302s to the nearest ACTUAL capture at or before
    // the requested timestamp (e.g. requesting 20200101000000 landed on 20191231234501). The
    // final redirected timestamp — never the requested one — is what must be reported back, or
    // an agent could cite a date the content isn't actually from.
    const page = await fetchArchivedPage(env, url, requestedTimestamp);
    const extracted = await extractFromHtml(page.html, url);
    return { actualTimestamp: page.actualTimestamp, html: page.html, ...extracted };
  });
}
