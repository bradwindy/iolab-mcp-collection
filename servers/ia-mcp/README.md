# ia-mcp

MCP server for Internet Archive / Wayback Machine research: find and read archived web pages,
track how pages and sites changed over time, search archive.org's item corpus, and read full text
of scanned public-domain books. Served at `/ia/mcp` on the gateway.

## Tools

| Tool | What it does | Upstream API | Needs a key? |
|---|---|---|---|
| `ia_wayback_search_captures` | Search every archived capture of a URL: timestamp, status, MIME type, content digest | CDX Server API | No |
| `ia_wayback_read_page` | Read the text/markdown/links/raw HTML of an archived page at a given (or most recent) capture | Wayback Machine (`id_` modifier) | No |
| `ia_wayback_get_capture_timeline` | First/last capture, per-year counts, largest gaps, distinct content versions | CDX Server API | No |
| `ia_wayback_diff_captures` | Compare two captures of the same URL and show what text changed | CDX + Wayback Machine | No |
| `ia_wayback_list_site_urls` | Discover which URLs under a site/path the Wayback Machine has captured | CDX Server API | No |
| `ia_wayback_find_nearest_capture` | Closest capture to a target date, before or after | CDX Server API | No |
| `ia_search_items` | Search archive.org's item corpus by keyword, media type, collection, year | `advancedsearch.php` | No |
| `ia_get_item` | Full metadata for one item: title, creator, description, licence, paginated files | Metadata API | No |
| `ia_search_inside_text` | Search within one text item's full text, with context and character offsets | Metadata + Download API | No |
| `ia_get_item_text` | Read a text item's full text sequentially | Metadata + Download API | No |
| `ia_openlibrary_search` | Bibliographic search that hands back archive.org identifiers for scanned editions | Open Library Search API | No |

Every tool works fully with no upstream API key — see "Upstream API keys" below for the one
optional exception and why it almost certainly doesn't matter.

## Upstream API keys

1. **archive.org S3-like keys** (`IA_S3_ACCESS_KEY` / `IA_S3_SECRET_KEY`) — **optional, and not
   known to change anything.** archive.org's automated-access docs describe an IA-S3
   `Authorization: LOW <access>:<secret>` header for "higher rate limits," but live testing found
   no evidence read endpoints treat it any differently: sending a deliberately invalid key changed
   nothing (no rejection, no behavioural difference), and archive.org's own IA-S3 documentation
   frames rate limiting around PUTs/DELETEs (uploads, the upload/delete queue), not reads. The CDX
   `503` throttling this server works around (see below) is IP-based and nothing indicates a key
   changes it. The plumbing is wired in via the portal in case that assumption turns out to be
   wrong, or in case Save Page Now support is ever added (out of scope for this server — it's
   100% read-only) — but don't expect it to change observed behaviour. Sign up at
   https://archive.org/account/s3.php.

## Research notes

- **The Scrape API v1 is not usable; `advancedsearch.php` is** — this inverts the standard advice
  (every source claims Scrape v1 replaced advancedsearch). Confirmed live: Scrape's `cursor` never
  advances (re-returns the identical first batch), it ignores the `q` parameter entirely, and
  `count` has a minimum of 100 so it can't serve a small tool page directly. `advancedsearch.php`
  behaved correctly on every check, with an explicit `sort[]` required for stable pagination.
- **The Availability API is unreliable** — `archive.org/wayback/available` returned
  `{"archived_snapshots": {}}` live for a URL with abundant captures. `ia_wayback_find_nearest_capture`
  uses CDX's own negative-`limit` behaviour (confirmed live: `limit=-1` returns the last matching
  row instead of the first) instead.
- **`__wb/sparkline` is dead** (404 on every parameter shape tried) — `ia_wayback_get_capture_timeline`
  is built entirely from CDX.
- **CDX throttles hard** — confirmed live, `503` after ~15-20 requests in a few minutes. Every
  client goes through `fetchWithBackoff` (retries on 429/5xx, honours `Retry-After`), and captures
  are cached aggressively (`CACHE_TTL.METADATA`) since a capture at a specific timestamp is
  immutable.
- **The `id_` capture URL 302s to the nearest actual capture, not necessarily the requested
  timestamp** — confirmed live: requesting `20200101000000` landed on `20191231234501`.
  `ia_wayback_read_page` and `ia_wayback_diff_captures` always report the actual redirected
  timestamp, never the requested one.
- **A book's full-text filename is never `<id>_djvu.txt` by convention** — confirmed live it's
  sometimes that, sometimes an arbitrary name (e.g. `b190w10.txt`). Always resolved from the
  metadata `files[]` array (`findFullTextFile` in `src/clients/archiveOrg.ts`).
- **In-copyright lending items 401 on file download; public-domain items 200** — confirmed live
  against a real lending-restricted item and a real public-domain one. `ia_search_inside_text` /
  `ia_get_item_text` surface this as an actionable "lending-restricted" error, distinct from a
  generic upstream failure.
- **No public "search inside a book" API could be verified** — `ia-fts.archive.org`,
  `ia-pub-fts-api.archive.org`, `ia-petabox.archive.org` are unreachable; `books-search0.us.archive.org`
  times out; every BookReader URL shape tried 404s. `ia_search_inside_text` achieves the same
  research capability by downloading and searching the resolved full-text file directly instead.
- **The metadata API has no top-level `identifier` field** — confirmed live: `GET /metadata/<id>`
  nests it at `metadata.identifier` instead; a nonexistent identifier responds 200 with `{}`, not a
  404. `ia_get_item` (and `ia_search_inside_text`/`ia_get_item_text`, which resolve full text
  through the same client) now read it from there, falling back to the requested identifier, and
  surface a `ItemNotFoundError` for the empty-body case instead of crashing on `undefined`.
- **`collection` mixes real collections with one `fav-<username>` entry per user who favorited the
  item** — confirmed live: a popular item like `nasa` carries 1,006 `collection` entries, 1,005 of
  them `fav-*`. `ia_get_item` and `ia_search_items` drop these unconditionally (`filterCollections`
  in `src/clients/archiveOrg.ts`) — they carry no research value and can otherwise balloon a single
  search response into tens of thousands of array entries.
- **`ia_search_inside_text` defaults to whole-word matching** — a plain substring search (still
  available via `whole_word: false`) matched "moa" inside "moans" and "amoaing", which is mostly
  noise for a real research query.
- **CDX's raw (uncollapsed) ordering can starve `ia_wayback_list_site_urls` down to almost nothing**
  — confirmed live against `trademe.co.nz`'s 1999–2001 range: CDX sorts by `(urlkey, timestamp)`, so
  a heavily-crawled URL (its homepage) filled ~130 of the first 150 raw rows, leaving none of the
  site's other ~5,000 distinct URLs represented in a small fetch window. Switched to CDX's own
  server-side `collapse=urlkey` (one row per distinct URL, however many times it was captured) —
  the tradeoff, since collapse always returns the *first* (earliest) row in a group with no
  server-side way to request the latest, is the output fields are honestly named `first_seen`/
  `first_status`, not "last".

## Example research questions

- "What did [organisation]'s homepage say about [topic] in 2014, and when did that wording change?"
  (`ia_wayback_search_captures` → `ia_wayback_read_page` / `ia_wayback_diff_captures`)
- "Find NASA's public-domain photo collections on archive.org and show me what's in one."
  (`ia_search_items` with `mediatype: "image"`, `collection: "nasa"` → `ia_get_item`)
- "Find a public-domain edition of [book] and quote what it says about [topic]."
  (`ia_openlibrary_search` → `ia_get_item` → `ia_search_inside_text`)
