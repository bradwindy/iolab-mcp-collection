# wikimedia-mcp

MCP server for Wikimedia reference research: search and read Wikipedia and its sister projects in any
language, browse how topics are categorised and cross-referenced, find freely-licensed media on
Wikimedia Commons, and look up structured facts in Wikidata. Served at `/wikimedia/mcp` on the gateway.

## Tools

| Tool | What it does | Upstream API | Needs a key? |
|---|---|---|---|
| `wikimedia_search_pages` | Full-text search with structured CirrusSearch filters: category (optionally deep), title, wikitext source, last-edit date, "more like this" | Action API `list=search` | No |
| `wikimedia_get_page` | Read a page's text; section-targeted, with an outline returned instead of the text for over-long articles | Action API `prop=extracts` + `action=parse` | No |
| `wikimedia_get_page_metadata` | Description, thumbnail, coordinates, size, Wikidata id, disambiguation flag, and language editions — up to 50 titles at once | Action API `prop=info\|description\|pageimages\|coordinates\|pageprops\|langlinks` | No |
| `wikimedia_get_backlinks` | What links to a page, transcludes a template, or uses a file | Action API `list=backlinks\|embeddedin\|imageusage` | No |
| `wikimedia_get_page_categories` | The categories a page is in, maintenance categories hidden by default | Action API `prop=categories` | No |
| `wikimedia_get_category_members` | The articles, subcategories, or files inside a category | Action API `list=categorymembers` | No |
| `wikimedia_search_media` | Search Commons for images, diagrams, audio, and video with licence and author | Commons Action API `generator=search` + `prop=imageinfo` | No |
| `wikimedia_get_media_info` | One file's URLs, dimensions, description, and full reuse requirements | Commons Action API `prop=imageinfo` + `extmetadata` | No |
| `wikimedia_search_entities` | Turn a name into a Wikidata Q-id or P-id | Action API `wbsearchentities` | No |
| `wikimedia_get_entity` | An entity's labels, aliases, and statements with referenced entities resolved to labels | Wikibase REST API v1 | No |
| `wikimedia_query_wikidata_sparql` | Read-only SPARQL against either Wikidata graph | Wikidata Query Service | No |

Every tool works fully with no upstream API key — see "Upstream API keys" below for the one optional
exception and what it actually buys.

## Projects and languages

The six wiki-content tools take `project` and `lang`. All seven projects expose the identical
MediaWiki Action API, so they cost nothing extra to support:

| `project` | Host | Note |
|---|---|---|
| `wikipedia` (default) | `{lang}.wikipedia.org` | |
| `wiktionary` | `{lang}.wiktionary.org` | Dictionary definitions |
| `wikisource` | `{lang}.wikisource.org` | Source texts |
| `wikiquote` | `{lang}.wikiquote.org` | Quotations |
| `wikivoyage` | `{lang}.wikivoyage.org` | Travel guides |
| `wikinews` | `{lang}.wikinews.org` | |
| `wikispecies` | `species.wikimedia.org` | **No language editions** — `lang` is ignored |

Commons and Wikidata have their own tools and no language editions, so they are not in the enum.

## Upstream API keys

1. **Wikimedia OAuth 2.0 access token** (`WIKIMEDIA_OAUTH_TOKEN`) — **optional, and almost certainly
   unnecessary.** Wikimedia's 2026 rate limits give an unauthenticated client with a compliant
   User-Agent **200 requests/minute**, against 200–2,000 for an authenticated one, and raise the
   Action API's concurrency cap from 1 to 3. 200/min is far beyond what an interactive LLM session
   uses, so every tool is written to work identically without it and none ever returns a
   missing-credential error. It is plumbed in for the case where this server is driven much harder
   than expected. Register an owner-only consumer at
   https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose and enter the token at
   `/admin/servers/wikimedia-mcp`.

   **Unverified against a real credential** — per `docs/ADDING_A_SERVER.md` §2 no agent may register a
   consumer or obtain a key, so the `Authorization: Bearer` path is written defensively against the
   documented OAuth 2.0 scheme and stays unexercised until an operator enters a token.

## Research notes

Everything below was confirmed by live HTTP probes on 2026-07-27, not read from documentation.

- **A library-default User-Agent gets a hard 403 from the CDN edge, before MediaWiki.** `curl -A
  'python-requests/2.31.0'` returned **403**; the same request with this server's descriptive
  User-Agent returned **200**. Enforcement rolled out under
  [T400119](https://phabricator.wikimedia.org/T400119) from September 2025. A compliant User-Agent is
  also worth 20x the throughput — an "unidentified" client is capped at 10 requests/minute against 200.
  Every request goes through `wikimediaFetch` in `src/clients/http.ts` for exactly this reason.
  (An *empty* User-Agent header was not blocked in testing; only library defaults were. The
  requirement is met regardless.)
- **`action=parse&prop=sections` is deprecated; `prop=tocdata` replaces it.** The live API says so
  itself: *"prop=sections has been deprecated. Please use prop=tocdata instead."* `tocdata` carries
  the same data under camelCase keys (`tocLevel`, `hLevel`, `fromTitle`, `codepointOffset`) and still
  exposes the `index` that `&section=N` consumes. Every other Wikipedia MCP server surveyed still uses
  the deprecated form.
- **`clshow=!hidden` silently loses categories.** Confirmed on `Kiwi (bird)` — 28 categories, 19 of
  them hidden maintenance categories: the filter is applied *after* the `cllimit` window is selected,
  and the response carries **no continuation token**. So `cllimit=3` returns **zero** categories and
  `cllimit=10` returns **one**, both reporting that there is nothing more to fetch, when the page
  actually has nine visible categories. `wikimedia_get_page_categories` therefore fetches the full 500
  with `clprop=hidden` and filters and paginates client-side.
- **Wikidata's query service is split into two disjoint graphs, and querying the wrong one returns
  zero rows rather than an error.** Counting `?s wdt:P31 wd:Q13442814` (scholarly article):
  `query.wikidata.org` → **0**, `query-scholarly.wikidata.org` → **45,681,217**. The split was
  finalised 20 January 2026 and re-merging is not planned. `wikimedia_query_wikidata_sparql` exposes
  the choice as a required-by-default `graph` parameter and, when a `main` query returns nothing,
  says so in the notice.
- **The Action API reports its own failures as HTTP 200.** Paging past the CirrusSearch ceiling
  returns `200` with `{"error":{"code":"cirrussearch-offset-too-large",...}}` in the body, so a
  status-only check treats a failure as success. `actionApi()` inspects the body and raises
  `ActionApiError`.
- **Only search is offset-paginated.** `list=search` and `generator=search` take `sroffset`/`gsroffset`
  (ceiling 10,000). Every other list module returns an opaque cursor — `blcontinue` is `ns|pageid`,
  `cmcontinue` is a hex sortkey blob. Those tools expose `cursor`/`next_cursor` rather than pretending
  to offset: synthesising an offset would mean re-walking every prior page on each call, against an
  API whose unauthenticated concurrency limit is **1**.
- **`en.wikispecies.org` does not exist** — it 301s away. Wikispecies is served only from
  `species.wikimedia.org`, with no language prefix, so the obvious `{lang}.{project}.org` template
  breaks for exactly this one project.
- **Commons `extmetadata` values are wrapped and sometimes contain HTML.** Every field is
  `{value, source, hidden?}` and must be unwrapped, and `Artist` is sometimes plain text
  ("John Gerrard Keulemans") and sometimes a raw anchor
  (`<a href="//commons.wikimedia.org/wiki/User:Alvesgaspar" ...>Alvesgaspar</a>`). Both are stripped
  before being returned.
- **Requested thumbnail widths are advisory.** `iiurlwidth=400` returned `thumbwidth: 400` alongside a
  `thumburl` containing `500px-`; `pithumbsize=400` behaved the same way. Commons rounds to standard
  buckets, so `thumbnail_url` is authoritative and the requested width is not promised.
- **Normalisation and redirection are separate steps.** `kiwi bird` is *normalised* to `Kiwi bird` and
  then *redirected* to `Kiwi (bird)`, reported in two distinct arrays. Both are surfaced, because
  collapsing them loses the difference between a capitalisation fixup and an editorial redirect.
- **`pageprops.disambiguation` is an empty string in both format versions** — key presence is the
  signal, not truthiness. `wikimedia_get_page` returns a disambiguation page's linked options instead
  of its prose, since the prose reads like an answer while naming several unrelated subjects.
- **Full article extracts are large.** `World War II` measures ~86,000 characters as plain text
  (~250,000 as wikitext, ~1.8 MB as Parsoid HTML). `wikimedia_get_page` returns a section outline plus
  the opening text above a `max_chars` budget rather than flooding the caller's context. Raw HTML is
  never exposed.
- **`exlimit` degrades silently.** Requesting multiple titles with `prop=extracts` but without
  `exintro` returns a full extract for the first title and `""` for the rest, with a warning rather
  than an error. Batching only works for intro extracts.
- **Wikidata property pages live under a `Property:` namespace.** `/wiki/P31` is a **404**;
  `/wiki/Property:P31` is a 200. Both Wikidata tools build the namespaced form for P-ids, since
  `type: "property"` searches return exactly the ids the naive form breaks on.
- **A SPARQL `VALUES` clause comes after the solution modifiers**, so appending `LIMIT n` to a query
  ending in `VALUES ?s { ... }` is a syntax error — confirmed live, the same query returns 200
  unmodified and 400 with the injection. The row cap is therefore injected only when it is provably
  safe, and enforced again on the returned rows regardless.
- **`api.wikimedia.org` and RESTBase are both being retired**; this server uses neither. The API
  Gateway was shut down in 2026 and Core API deprecation began July 2026, with no replacement routes
  announced. RESTBase's `page/related`, `page/mobile-sections`, and `page/data-parsoid` already return
  403, and `page/summary` — which every other Wikipedia MCP server depends on — has no announced
  replacement. Everything here runs on the per-wiki Action API and the Wikibase REST API, both stable.

## Example research questions

- "What does Wikipedia say about kiwi conservation, and what has changed in how the article
  classifies the species?" (`wikimedia_search_pages` with `in_category` → `wikimedia_get_page` with a
  `section` → `wikimedia_get_page_categories`)
- "Find every article about a bird endemic to New Zealand, and a freely-reusable photo of one."
  (`wikimedia_get_category_members` → `wikimedia_search_media` → `wikimedia_get_media_info`)
- "What structured facts does Wikidata hold about the kiwi genus, and which other species share its
  conservation status?" (`wikimedia_get_page_metadata` for `wikibase_item` → `wikimedia_get_entity` →
  `wikimedia_query_wikidata_sparql`)
- "How is this topic covered differently in te reo Māori?" (`wikimedia_get_page_metadata` with
  `include_languages` → `wikimedia_get_page` with `lang: "mi"`)
