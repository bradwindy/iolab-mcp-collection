import { CACHE_TTL, cached, rateLimitHint, UpstreamHttpError, upstreamError, type ToolTextResult } from "@iolab/mcp-kit";
import { iaFetch } from "./http.js";

const CDX_URL = "https://web.archive.org/cdx/search/cdx";
export const SOURCE = "Wayback Machine";

const COOLDOWN_KEY = "ia:wayback:cooldown-until";
/** Used when a 429 carries no usable Retry-After. Workers KV's 60s TTL floor is the lower bound. */
const DEFAULT_COOLDOWN_SECONDS = 300;
const MAX_COOLDOWN_SECONDS = 3600;

function retryAfterSeconds(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  const value = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : DEFAULT_COOLDOWN_SECONDS;
  return Math.min(Math.max(value, 60), MAX_COOLDOWN_SECONDS);
}

/**
 * Every web.archive.org request goes through here, never `iaFetch` directly. Internet Archive
 * staff have stated the CDX API allows an average of 60 requests/minute, and that a client which
 * keeps sending requests after a 429 for over a minute gets its IP blocked for an hour (doubling
 * on repeat). Our egress is a shared Cloudflare IP, so the old behaviour — retrying every 429
 * three times, then every agent retrying the tool on top — was the worst possible response. So:
 *
 * - 429 is never retried here (5xx and network errors still are, for the CDX 503s seen live).
 * - The first 429 records a server-wide cooldown in KV, and every Wayback call during it fails
 *   fast with a synthetic 429 instead of touching upstream at all.
 */
export async function waybackFetch(env: Env, url: string | URL, init: RequestInit = {}): Promise<Response> {
  const until = Number(await env.MCP_CACHE.get(COOLDOWN_KEY));
  const remainingSeconds = Math.ceil((until - Date.now()) / 1000);
  if (Number.isFinite(until) && remainingSeconds > 0) {
    throw new UpstreamHttpError(
      SOURCE,
      new Response(null, {
        status: 429,
        statusText: "Too Many Requests (cooling down, request not sent)",
        headers: { "retry-after": String(remainingSeconds) },
      }),
    );
  }

  const response = await iaFetch(env, url, init, {
    retryOn: (res) => !res || res.status >= 500,
  });
  if (response.status === 429) {
    const seconds = retryAfterSeconds(response);
    await env.MCP_CACHE.put(COOLDOWN_KEY, String(Date.now() + seconds * 1000), { expirationTtl: seconds });
  }
  return response;
}

/**
 * `upstreamError` for Wayback failures: a 429 also points the agent at the two tools that can
 * still answer from other web archives (see clients/otherArchives.ts) while Wayback cools down.
 */
export function waybackError(error: UpstreamHttpError): ToolTextResult {
  if (error.response.status !== 429) return upstreamError(error.source, error.response);
  return upstreamError(
    error.source,
    error.response,
    `${rateLimitHint(error.response)} Meanwhile ia_wayback_read_page and ia_wayback_find_nearest_capture can still answer from other web archives.`,
  );
}

export type CdxCollapse = "none" | "hour" | "day" | "month" | "year" | "digest" | "urlkey";

/** Maps the tool-facing collapse granularity to CDX's own `collapse` parameter value. */
function collapseParam(collapse: CdxCollapse): string | null {
  switch (collapse) {
    case "none":
      return null;
    case "hour":
      return "timestamp:10";
    case "day":
      return "timestamp:8";
    case "month":
      return "timestamp:6";
    case "year":
      return "timestamp:4";
    case "digest":
      return "digest";
    case "urlkey":
      // One row per distinct URL — CDX's own field name, not a timestamp-truncation prefix like
      // the cases above. Confirmed live: returns the FIRST (earliest in range) row per urlkey, not
      // the most recent — see waybackListSiteUrls.ts, the one caller of this mode, for why that's
      // an acceptable tradeoff there.
      return "urlkey";
  }
}

export type CdxRow = {
  urlkey: string;
  timestamp: string;
  original: string;
  mimetype: string;
  statuscode: string;
  digest: string;
  length: string;
};

const CDX_FIELDS = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"] as const;

/**
 * Low-level CDX Server API query (https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md).
 * Confirmed live: returns a JSON array-of-arrays, first row is the header (matching CDX_FIELDS
 * exactly), never a wrapper object. `matchType=domain`/`prefix` + `collapse=urlkey` is how site
 * structure discovery works (verified live against iana.org). `rawLimit` is passed straight
 * through, including negative values — confirmed live that CDX treats a negative limit as "last N
 * rows" rather than "first N", which is what powers `find_nearest_capture`'s "closest capture
 * before" query (`to=<target>&limit=-1`) without fetching every capture up to that date.
 */
export async function queryCdxRaw(
  env: Env,
  params: {
    url: string;
    matchType?: "exact" | "prefix" | "host" | "domain" | undefined;
    from?: string | undefined;
    to?: string | undefined;
    statusFilter?: string | undefined;
    mimeFilter?: string | undefined;
    collapse?: CdxCollapse | undefined;
    rawLimit: number;
  },
): Promise<CdxRow[]> {
  const requestUrl = new URL(CDX_URL);
  requestUrl.searchParams.set("url", params.url);
  requestUrl.searchParams.set("output", "json");
  requestUrl.searchParams.set("fl", CDX_FIELDS.join(","));
  if (params.matchType) requestUrl.searchParams.set("matchType", params.matchType);
  if (params.from) requestUrl.searchParams.set("from", params.from);
  if (params.to) requestUrl.searchParams.set("to", params.to);
  // CDX supports multiple `filter` params (AND-ed together) — must `append`, not `set`, or a
  // second filter silently replaces the first instead of narrowing alongside it.
  if (params.statusFilter) requestUrl.searchParams.append("filter", `statuscode:${params.statusFilter}`);
  if (params.mimeFilter) requestUrl.searchParams.append("filter", `mimetype:${params.mimeFilter}`);
  const collapse = params.collapse ? collapseParam(params.collapse) : null;
  if (collapse) requestUrl.searchParams.set("collapse", collapse);
  requestUrl.searchParams.set("limit", String(params.rawLimit));

  // Cached because agents re-run the same lookup constantly (and find_nearest_capture/diff_captures
  // fan out several per call) — every repeat that skips upstream is quota left for a new query.
  // SLOW_MOVING, not METADATA: new captures do land, but half an hour stale is harmless here.
  const raw = await cached(env.MCP_CACHE, `ia:cdx:${requestUrl.toString()}`, CACHE_TTL.SLOW_MOVING, async () => {
    const response = await waybackFetch(env, requestUrl);
    if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
    const body = (await response.text()).trim();
    return body ? (JSON.parse(body) as string[][]) : [];
  });

  const dataRows = raw.slice(1); // first row is the header
  return dataRows.map((row) => ({
    urlkey: row[0] ?? "",
    timestamp: row[1] ?? "",
    original: row[2] ?? "",
    mimetype: row[3] ?? "",
    statuscode: row[4] ?? "",
    digest: row[5] ?? "",
    length: row[6] ?? "",
  }));
}

/**
 * Offset/limit pagination over `queryCdxRaw` — fetches `offset + limit + 1` rows (the +1 is the
 * has-more probe) and slices client-side, since CDX has no native `offset`. CDX's default
 * ordering (by urlkey then timestamp) is deterministic, so this is stable across pages per this
 * repo's own pagination best practice.
 */
export async function queryCdx(
  env: Env,
  params: {
    url: string;
    matchType?: "exact" | "prefix" | "host" | "domain" | undefined;
    from?: string | undefined;
    to?: string | undefined;
    statusFilter?: string | undefined;
    mimeFilter?: string | undefined;
    collapse?: CdxCollapse | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ rows: CdxRow[]; hasMore: boolean }> {
  const dataRows = await queryCdxRaw(env, { ...params, rawLimit: params.offset + params.limit + 1 });
  const rows = dataRows.slice(params.offset, params.offset + params.limit);
  const hasMore = dataRows.length > params.offset + params.limit;
  return { rows, hasMore };
}

/** `YYYYMMDDHHMMSS` -> ISO 8601. CDX timestamps are always UTC, always this exact 14-digit shape. */
export function cdxTimestampToIso(timestamp: string): string {
  const y = timestamp.slice(0, 4);
  const mo = timestamp.slice(4, 6);
  const d = timestamp.slice(6, 8);
  const h = timestamp.slice(8, 10) || "00";
  const mi = timestamp.slice(10, 12) || "00";
  const s = timestamp.slice(12, 14) || "00";
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

export function archivedUrl(timestamp: string, original: string): string {
  return `https://web.archive.org/web/${timestamp}/${original}`;
}

export type ArchivedPage = {
  /** The capture timestamp actually served — see the docstring below for why this can differ from the requested one. */
  actualTimestamp: string;
  html: string;
  contentType: string;
};

/**
 * Fetches the raw, unrewritten HTML of a capture via the `id_` modifier. Confirmed live: this
 * always 302s to the nearest *actual* capture at or before the requested timestamp — e.g.
 * requesting `20200101000000` landed on `20191231234501`. The final redirected URL's timestamp is
 * what's returned as `actualTimestamp`; callers MUST report that, not the requested one, or an
 * agent could cite a date the content isn't actually from.
 */
export async function fetchArchivedPage(env: Env, url: string, timestamp: string): Promise<ArchivedPage> {
  const requestUrl = `https://web.archive.org/web/${timestamp}id_/${url}`;
  const response = await waybackFetch(env, requestUrl, { redirect: "follow" });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const finalUrl = response.url;
  const match = /\/web\/(\d{14})(?:id_)?\//.exec(finalUrl);
  const actualTimestamp = match?.[1] ?? timestamp;

  const html = await response.text();
  return { actualTimestamp, html, contentType: response.headers.get("content-type") ?? "text/html" };
}
