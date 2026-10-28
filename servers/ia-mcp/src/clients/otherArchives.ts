import { USER_AGENT } from "./http.js";

export type OtherArchive = {
  name: string;
  homepage: string;
  /** pywb/OpenWayback-style replay prefix: `${base}${timestamp}/${url}`. */
  base: string;
};

/**
 * Fallbacks for when the Wayback Machine is rate-limiting us. Each must run Memento-compliant
 * Wayback-style replay, so `${base}${timestamp}id_/${url}` redirects to the capture closest to
 * `timestamp` and serves its raw HTML, the same shape `fetchArchivedPage` relies on. Arquivo.pt
 * does (confirmed live from the deployed gateway). It holds far fewer captures than Wayback, so a
 * miss is normal.
 *
 * The NZ Web Archive (ndhadeliver.natlib.govt.nz) was tried and removed: confirmed live, its
 * `/webarchive/<ts>id_/<url>` answers HTTP 200 at the requested URL with no redirect, serving a
 * JavaScript app shell rather than the archived page, so there is no raw HTML or real capture
 * timestamp to read from a Worker.
 */
export const OTHER_ARCHIVES: readonly OtherArchive[] = [
  {
    name: "Arquivo.pt",
    homepage: "https://arquivo.pt/",
    base: "https://arquivo.pt/wayback/",
  },
];

const PER_ARCHIVE_TIMEOUT_MS = 10_000;

export type OtherArchiveCapture = {
  archive: OtherArchive;
  actualTimestamp: string;
  /** Human-viewable replay URL (no `id_`), for citing. */
  archivedUrl: string;
  html: string;
  contentType: string;
};

/**
 * Asks each fallback archive in turn for the capture of `url` closest to `timestamp`. Returns
 * the first hit, or null if none has one. Never throws: a fallback failing must leave the
 * original Wayback error intact, not replace it with a less useful one. Deliberately plain fetch,
 * not `iaFetch` — the optional archive.org S3 keys must never be sent to another archive.
 */
export async function findInOtherArchives(
  url: string,
  timestamp: string,
  opts: { readBody: boolean },
): Promise<OtherArchiveCapture | null> {
  for (const archive of OTHER_ARCHIVES) {
    try {
      const response = await fetch(`${archive.base}${timestamp}id_/${url}`, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(PER_ARCHIVE_TIMEOUT_MS),
      });
      const match = /\/(\d{14})(?:id_)?\//.exec(response.url);
      if (!response.ok || !match?.[1]) {
        // Logged so a fallback that never answers is diagnosable from Workers Logs.
        console.error(`[ia-mcp] fallback archive ${archive.name} had no capture: HTTP ${response.status} url=${response.url}`);
        await response.body?.cancel();
        continue;
      }
      const actualTimestamp = match[1];
      const html = opts.readBody ? await response.text() : "";
      if (!opts.readBody) await response.body?.cancel();
      return {
        archive,
        actualTimestamp,
        archivedUrl: `${archive.base}${actualTimestamp}/${url}`,
        html,
        contentType: response.headers.get("content-type") ?? "text/html",
      };
    } catch (error) {
      console.error(`[ia-mcp] fallback archive ${archive.name} failed`, error);
    }
  }
  return null;
}
