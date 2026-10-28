import { CACHE_TTL, cached, UpstreamHttpError } from "@iolab/mcp-kit";
import { findInOtherArchives } from "./clients/otherArchives.js";
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

export type PageSource = { name: string; url: string; archivedUrl: string | null };

/**
 * `fetchAndExtractPage`, but when the Wayback Machine is rate-limiting this server (HTTP 429,
 * including the cooldown short-circuit in clients/wayback.ts), tries the other archives in
 * clients/otherArchives.ts before giving up. Rethrows the original Wayback error if none has a
 * capture. Fallback hits are cached under their own key so a cached fallback never masks Wayback
 * once it recovers for longer than SLOW_MOVING.
 */
export async function fetchAndExtractPageWithFallback(env: Env, url: string, requestedTimestamp: string) {
  try {
    const page = await fetchAndExtractPage(env, url, requestedTimestamp);
    return { ...page, source: { name: "Internet Archive Wayback Machine", url: "https://web.archive.org/", archivedUrl: null } as PageSource };
  } catch (error) {
    if (!(error instanceof UpstreamHttpError) || error.response.status !== 429) throw error;
    const cacheKey = `ia:page-other:${requestedTimestamp}:${url}`;
    const fallback = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.SLOW_MOVING, async () => {
      const capture = await findInOtherArchives(url, requestedTimestamp, { readBody: true });
      if (!capture) return null;
      const extracted = await extractFromHtml(capture.html, url);
      const source: PageSource = { name: capture.archive.name, url: capture.archive.homepage, archivedUrl: capture.archivedUrl };
      return { actualTimestamp: capture.actualTimestamp, html: capture.html, ...extracted, source };
    });
    if (!fallback) throw error;
    return fallback;
  }
}
