# nz-stats-mcp

MCP server for New Zealand official statistics, via Stats NZ's **Aotearoa Data Explorer** SDMX
API — subnational population estimates, business demography, and a raw SDMX dataflow escape
hatch covering everything else Stats NZ publishes there (census, income, labour, injury,
justice, agriculture, and more).

This is the hardest server in the nz-mcp-collection: unlike the other servers' upstream APIs,
Aotearoa Data Explorer has no fixed REST endpoint shape. It's SDMX (Statistical Data and
Metadata eXchange) — a general standard for exchanging statistical data — and a request URL
for one specific table is normally hand-built from that table's dataflow ID and dimension
structure, or copied out of the Aotearoa Data Explorer browser's "Developer API" menu.

## What it does

Four tools, all requiring a Stats NZ API portal subscription key (see below):

| Tool | Description |
|---|---|
| `nz_stats_search_dataflows` | Search Aotearoa Data Explorer's full STATSNZ dataflow catalogue (911 tables as of 2026-07-09) by keyword. Use this to find a `dataflow_id` for `nz_stats_query_dataflow`. |
| `nz_stats_get_population_by_area` | Curated: subnational population estimates by area (Regional Council or SA2) and year (STATSNZ dataflow `POPES_SUB_004`). |
| `nz_stats_get_business_demography` | Curated: enterprise counts by industry and year, from the Business Demography Statistics collection (STATSNZ dataflow `BDS_BDS_004`). |
| `nz_stats_query_dataflow` | Escape hatch: run a raw SDMX data query against any STATSNZ dataflow, once you know (or have found via `nz_stats_search_dataflows`) its dataflow ID. |

Every tool follows the collection's conventions: `response_format: "concise"｜"detailed"`
(default concise), pagination with `limit`/`offset`/`total_count`/`has_more`/`next_offset`,
truncation notices, `outputSchema` + `structuredContent`, actionable tool-execution errors,
`readOnlyHint`/`openWorldHint` annotations, TTL caching (24h, since official statistics
change at most daily and usually far less often) via the shared `MCP_CACHE` KV namespace, and
client-side rate-limit backoff via `fetchWithBackoff`.

## Required credential: `STATS_NZ_SUBSCRIPTION_KEY`

The Aotearoa Data Explorer API's `accessModel` is `"account"` — there is no public,
no-key path for any of it (unlike this collection's other servers). Every tool call reads
the key from the shared, encrypted credential store
(`getCredential(env.CREDENTIALS_DB, "nz-stats-mcp", "STATS_NZ_SUBSCRIPTION_KEY", env.ENCRYPTION_KEY)`)
and returns an actionable `missingCredentialError` if it isn't set yet.

### How to get one

1. Go to the [Stats NZ API Portal](https://portal.apis.stats.govt.nz/) and sign in, or
   register a new account if you don't have one
   ([how-to-subscribe guide](https://portal.apis.stats.govt.nz/how-to-subscribe)).
2. Open **Explore APIs**, find the Aotearoa Data Explorer API product, and subscribe
   (give the subscription a name and confirm).
3. Open your **Profile**, and display (or regenerate) your subscription key.
4. Set it for this server: `POST {portal}/servers/nz-stats-mcp` with
   `{ "key_name": "STATS_NZ_SUBSCRIPTION_KEY", "value": "<your key>" }` (or via the
   nz-mcp-collection portal UI once it's live) — this encrypts and stores it in the shared
   `nz-mcp-credentials` D1 database, keyed by this server's name.
5. Send every request with the header `Ocp-Apim-Subscription-Key: <your key>` — this server
   does that for you once the credential is set.

Stats NZ notes: use a team/shared email to register rather than an individual's, since
sharing a single key across many people can trigger rate limiting; and a request made
without the key returns `401 { "statusCode": 401, "message": "Access denied due to missing
subscription key. Make sure to include subscription key when making requests to an API." }`
(confirmed live against the production API on 2026-07-09).

## Example research questions

- "How has Auckland's population changed relative to Canterbury's since 2013?" →
  `nz_stats_get_population_by_area(area_code: "02,13", start_year: 2013)`
- "How many enterprises were operating in New Zealand each year since 2015?" →
  `nz_stats_get_business_demography(start_year: 2015)`
- "What tables does Stats NZ publish about household income?" →
  `nz_stats_search_dataflows(query: "income")`, then feed a `dataflow_id` from the results
  into `nz_stats_query_dataflow`.

## Research notes

Real effort went into pinning down the SDMX request shape before writing any code — this
section records what was confirmed live, what came from official documentation, and what
remains an educated, clearly-flagged assumption pending a real subscription key.

### SDMX request structure (confirmed via official docs)

Fetched and read in full: the
[Aotearoa Data Explorer API user guide](https://www.stats.govt.nz/tools/aotearoa-data-explorer/ade-api-user-guide/)
(the page is JS-rendered; its content was extracted from the page's embedded
`pageViewData`/`PageBlocks` JSON, not from a rendered screenshot) and the
[.Stat Suite RESTful web service cheat sheet](https://sis-cc.gitlab.io/dotstatsuite-documentation/using-api/restful/)
(Aotearoa Data Explorer runs on the .Stat Suite platform).

- Base URL: `https://api.data.stats.govt.nz/rest/` (what the ADE browser's own "Developer
  API" menu generates; an alternate `http://apis.stats.govt.nz/ade-api/rest/` is documented
  as interchangeable).
- Data query: `GET {base}/data/{agencyID},{dataflowID}[,{version}]/{key}?{params}`. `{key}`
  is dot-separated per dimension, `+` ORs multiple codes within one dimension, a blank
  segment means "all codes for that dimension", and `all` is a literal shortcut for "every
  dimension, every code". This dimension ordering is table-specific — Stats NZ's own worked
  example (`AGR_AGR_001`) builds the key in the order the table's structural metadata
  declares its dimensions, which is *not* generally the same as alphabetical or a fixed
  universal order.
- Structure query: `GET {base}/{structure}/{agencyID}/{resourceID}[/{version}]?{params}`,
  `{structure}` being `dataflow`, `datastructure`, `codelist`, or `categorisation`.
- `format` query param: `jsondata` (JSON), `xml` (default), `csv`, `csvfile`,
  `csvfilewithlabels`.
- Auth header: `Ocp-Apim-Subscription-Key` (mandatory on data requests; see below on
  structure requests). Stats NZ's API Portal runs on Azure API Management — a 401 response
  carries `www-authenticate: AzureApiManagementKey realm="https://apis.stats.govt.nz/ade-api",name="Ocp-Apim-Subscription-Key",type="header"`.
- `startPeriod`/`endPeriod`/`dimensionAtObservation`/`firstNObservations`/`lastNObservations`
  are documented, standard SDMX 2.1 REST parameters for the underlying .Stat Suite platform,
  but the ADE user guide itself never demonstrates or mentions them — its own worked example
  encodes a year directly in `{key}` instead. This suggests Stats NZ models "Year" as an
  ordinary coded dimension rather than SDMX's special `TIME_PERIOD` concept on (at least)
  the tables this server curates, since census years are irregularly spaced. `nz_stats_get_population_by_area`
  and `nz_stats_get_business_demography` therefore build year selection into `{key}`, not
  `startPeriod`/`endPeriod`. `nz_stats_query_dataflow` still accepts `start_period`/
  `end_period` as an optional passthrough for tables that *do* have a real time dimension,
  with a description noting it may be a no-op otherwise.

### Live-confirmed facts (fetched 2026-07-09, no subscription key required for these two calls)

`GET https://api.data.stats.govt.nz/rest/dataflow/STATSNZ/all` and the same URL with
`?detail=allstubs` both returned **HTTP 200** with the full XML dataflow catalogue, despite
no `Ocp-Apim-Subscription-Key` header being sent. Every other structural-metadata and data
request tried the same way (a `datastructure` request for a specific dataflow, a data
request for `AGR_AGR_001`) reliably returned `401`. The 200 responses carried
`cache-control: public,max-age=600` and `cf-cache-status: HIT` — this reads as a Cloudflare
edge cache artifact (someone else's authenticated request for that exact common URL was
cached and briefly served back to an unauthenticated one), not a genuinely public code path.
**This server always sends the subscription key on every request regardless**, per the
catalog's documented `accessModel: "account"` and this task's explicit instructions — the
caching quirk was useful for research, not something to build production behavior on.

Using that access, the live STATSNZ catalogue (911 dataflows) was fetched and searched
exhaustively for CPI (Consumers Price Index) and HLFS (Household Labour Force Survey)
dataflows — the two other "classic" series named in this task's brief alongside population
and business demography. **Neither exists in the catalogue as of 2026-07-09.** The 911
dataflows span only: Agriculture (`AGR`), Business Demography Statistics (`BDS`), the 2013/
2018/2023 Censuses (`CEN13`/`CEN18`/`CEN23`), Corrections (`CORR`), the Household Economic
Survey (`HES`), Income (`INC`), Injury statistics (`INJ`), Iwi (`IWI18`), Justice (`JUS`),
Linked Employer-Employee Data (`LEED`), population estimates (`POPES`), population
projections (`POPPR`), and Productivity (`PRD`). A web search corroborated this: Stats NZ is
still migrating tables from the old NZ.Stat system into Aotearoa Data Explorer
incrementally, and CPI/HLFS were not yet found published via SDMX at the time of writing.
**No CPI or HLFS tool was built, and no dataflow ID was fabricated for either** — per this
task's explicit instruction to prefer the escape hatch over guessing. If Stats NZ publishes
either later, add a curated tool the same way `getPopulationByArea.ts`/
`getBusinessDemography.ts` were built, using `nz_stats_search_dataflows` to locate the new
dataflow ID.

### The two curated dataflows

Both were selected from that same live catalogue fetch, and their exact dimension layout,
defaults, and codes were read from their own SDMX annotations (also fetched live, unauthenticated,
via the same cached-edge-response path) — not guessed:

- **`POPES_SUB_004`** — "Subnational population estimates (RC, SA2), by age and sex, at 30
  June 1996-2025 (2025 boundaries)". Its structural annotations state
  `LAYOUT_ROW=AREA,SEX,AGE` / `LAYOUT_COLUMN=YEAR`, and a `DEFAULT` annotation giving the
  exact default codes: `SEX=3` (confirmed as "Total"), `AGE=999999` (confirmed as "Total all
  ages"), the 16 Regional Council codes + `99`/`NIRC`/`SIRC`/`RC9999` for area, and
  `YEAR=1996,2001,2006,2013,2018,2023,2024,2025` (an irregular set, matching census years
  plus the two latest estimates — hence encoding year directly into `{key}` rather than via
  `startPeriod`/`endPeriod`).
- **`BDS_BDS_004`** — "Enterprises by industry 2000-2025". Annotations state
  `LAYOUT_ROW=YEAR` / `LAYOUT_COLUMN=ANZSIC06,MEASURE`, with `DEFAULT ANZSIC06=TOTAL`. No
  default `MEASURE` or explicit year codelist was published in the annotation the way
  `POPES_SUB_004`'s was — the 2000-2025 year range comes from the dataflow's *title text*,
  not a fetched codelist, so annual codes "2000".."2025" are assumed to exist as consecutive
  integers but individual codes were not each confirmed.

### Open question: dimension key ordering, and the SDMX-JSON response shape

Two things could **not** be verified against a live, authenticated response, because no
real subscription key was available while building this server (per this task's explicit
constraints):

1. **Whether `{key}` order is truly "row dimensions, then column dimensions"** for these two
   tables. That pattern is consistent with Stats NZ's own worked example in the API guide
   (a 3-dimension table where the row dimension appeared before the column dimension in the
   key), and with the LAYOUT_ROW/LAYOUT_COLUMN annotations fetched for both curated
   dataflows, but a raw `datastructure` request — which would state the DSD's dimension
   order unambiguously — 401'd every time it was tried (it wasn't a commonly-cached URL like
   the catalogue endpoints were). If `nz_stats_get_population_by_area` or
   `nz_stats_get_business_demography` ever return an empty result set where data should
   exist, that's the most likely cause — fall back to `nz_stats_query_dataflow` with a
   `dimension_key` copied verbatim from that table's "Data query" URL in the Aotearoa Data
   Explorer browser's Developer API menu, which is guaranteed correct.
2. **The exact SDMX-JSON response shape** `format=jsondata` returns. This server's parser
   (`flattenSdmxJson` in `src/clients/statsNzSdmx.ts`) is built against the documented,
   widely-implemented SDMX-JSON 2.1 "data message" shape (`dataSets[0].series` keyed by
   colon-separated dimension-value indexes, cross-referenced against
   `structure.dimensions.series`/`.observation`) used by other SDMX 2.1-compliant national
   statistics agencies. It is deliberately defensive: dimensions are matched by an id
   *prefix* (e.g. `findDim(dims, "AREA_")`) rather than an assumed fixed position, since
   dimension ids here are dataflow-suffixed (e.g. `AREA_POPES_SUB_004`) and confirmed
   splitting between "series" vs. "observation" dimensions couldn't be checked live. If the
   real response shape differs, `flattenSdmxJson` throws a clear, tool-facing error
   (surfaced as an `isError` result with a hint to use `format="xml"` via
   `nz_stats_query_dataflow` to inspect the raw structure) rather than silently returning
   wrong data.

**Live verification is pending a real Stats NZ subscription key.** Once one is available:
run `nz_stats_get_population_by_area` and `nz_stats_get_business_demography` for real, and
if the observations returned don't match a manual check in the Aotearoa Data Explorer
browser, capture a real response body and compare it against `flattenSdmxJson`'s
assumptions (most likely fix: adjusting which SDMX-JSON shape variant is parsed, not the
dataflow IDs or key-building logic, which are independently confirmed).

### Regional Council code labels

`REGIONAL_COUNCIL_NAMES` in `src/constants.ts` is a fallback label map (for error messages
and human-readable output before a live response is available) built from Stats NZ's
[Statistical standard for geographic areas 2023](https://www.stats.govt.nz/assets/Methods/Statistical-standard-for-geographic-areas-2023/statistical-standard-for-geographic-areas-2023-updated-december-2023.pdf)
(16 regions + "99 Area Outside Region" = 17 categories, confirmed via web search), with code
numbers cross-checked against the live `POPES_SUB_004` DEFAULT annotation. At runtime, tool
output prefers whatever label Stats NZ's own SDMX-JSON response embeds for the codes
actually returned — this map is a fallback and a documentation aid, not the source of truth.
