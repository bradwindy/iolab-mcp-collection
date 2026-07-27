# wikimedia-mcp

MCP server for Wikimedia reference research: search and read Wikipedia and its sister projects in any
language, browse how topics are categorised and cross-referenced, find freely-licensed media on
Wikimedia Commons, and look up structured facts in Wikidata. Served at `/wikimedia/mcp` on the gateway.

## Tools

| Tool | What it does | Upstream API | Needs a key? |
|---|---|---|---|
| `wikimedia_search_pages` | Full-text search with structured CirrusSearch filters: category (optionally deep), title, wikitext source, last-edit date, "more like this" | Action API `list=search` | No |
| `wikimedia_get_page` | Read an article's full text, one section, or several at once; over-long articles return an outline with exact per-section sizes; optional structured citations | Action API `prop=extracts` + `action=parse&prop=text\|tocdata` | No |
| `wikimedia_get_page_metadata` | Description, thumbnail, coordinates, size, Wikidata id, disambiguation flag, quality grade, maintenance flags, protection and language editions — up to 50 titles at once, in order | Action API `prop=info\|description\|pageimages\|coordinates\|pageprops\|langlinks\|pageassessments\|categories` | No |
| `wikimedia_get_backlinks` | What links to a page, transcludes a template, or uses a file | Action API `list=backlinks\|embeddedin\|imageusage` | No |
| `wikimedia_get_page_categories` | The categories a page is in, maintenance categories hidden by default | Action API `prop=categories` | No |
| `wikimedia_get_category_members` | The articles, subcategories, or files inside a category | Action API `list=categorymembers` | No |
| `wikimedia_search_media` | Search Commons for images, diagrams, audio, and video with licence and author | Commons Action API `generator=search` + `prop=imageinfo` | No |
| `wikimedia_get_media_info` | One file's URLs, dimensions, description, and full reuse requirements | Commons Action API `prop=imageinfo` + `extmetadata` | No |
| `wikimedia_search_entities` | Turn a name into a Wikidata Q-id or P-id | Action API `wbsearchentities` | No |
| `wikimedia_get_entity` | An entity's labels, aliases, and statements with qualifiers, units, time precision and references; entity ids resolved to labels | Wikibase REST API v1 + `wbgetentities` | No |
| `wikimedia_query_wikidata_sparql` | Read-only SPARQL against either Wikidata graph | Wikidata Query Service | No |

Every tool works fully with no upstream API key — see "Upstream API keys" below for the one optional
exception and what it actually buys.

## Projects and languages

The six wiki-content tools take `project` and `lang`. All eight projects expose the identical
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
| `commons` | `commons.wikimedia.org` | **No language editions** — `lang` is ignored. For browsing media *categories*; files themselves have dedicated tools |

Wikidata has its own tools and no language editions, so it is not in the enum.

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

- **CirrusSearch already folds macrons; the recall problem is the AND, not the diacritics.** `Ōpepe`
  and `Opepe` return the identical 20 hits — `action=cirrus-schema-dump` shows the `text` and
  `text_search` analyzers both ending in `icu_folding`. What loses the article is that every term is
  a `MUST`: `Ōpepe ambush 1869 Taupō` returned **1** unrelated hit because `Opepe, New Zealand` never
  uses the word "ambush". `srqdprofile=perfield_builder_relaxed` (`minimum_should_match: '3<-1
  5<50%'`) returns **10** with the right article first, and turned
  `Ngāti Tūwharetoa Taupō lakebed ownership fishing licences` from **0** hits into **780**. Queries of
  three terms or fewer are unaffected. Do not use `perfield_builder_title_filter` — it made the same
  query return zero.
- **Quoted phrases and `insource:` are diacritic-*sensitive*, unlike free text.** The `plain_search`
  analyzer has no `icu_folding`. `intitle:"Ōpepe"` returns **0** hits against `intitle:"Opepe"`'s 2,
  and `insource:"Ōpepe"` returns 4 against 20. This is the only place client-side folding helps, and
  it is applied to exactly those two parameters.
- **Never act on `searchinfo.suggestion` for macronised queries.** The phrase suggester runs against
  the already-folded index, so a diacritic has zero edit distance to it and it spends its budget
  elsewhere: `Taupō` → `tampa`, `Opepe` → `opera`, `Ōpepe Taupō` → `ōhope tampa`.
- **`lasteditdate:>` excludes the boundary day.** `lasteditdate:>2026-07-27 Taupō` returned **0**
  hits where `>=2026-07-27` returned **35**.
- **`action=parse&section=N` is the wrong way to read a section.** It renders the section in
  isolation, so a `<ref name>` defined elsewhere emits
  `Cite error: The named reference X was invoked but never defined` into the prose; it appends a
  partial reference list (56% of one `Taupō Volcano` section's payload); it takes one section per
  call (`section=1|2` is `invalidsection`); and it cannot address a transcluded section, whose index
  is `T-1`. A whole-page parse has **zero** cite errors — checked on `Taupō Volcano`, `Lake Taupō`,
  `World War II` and `New Zealand`.
- **`HTMLRewriter` does not decode character references.** Both text chunks and `getAttribute` hand
  back the raw source slice, so `&#160;` and `&amp;` survive unless decoded explicitly.
  `mobileformat=1` removes most of the problem upstream — on `Taupō Volcano` it took `&#160;` from
  141 to 0, `&#8202;` from 68 to 0 and `&#91;` from 86 to 0. **Never send `mobileformat=0`**:
  MediaWiki booleans are true whenever the parameter is present at all.
- **There is no references API.** `/api/rest_v1/page/references/{title}` 404s on every title tried,
  `mobile-sections` now returns 403, and `/w/rest.php/v1/` has no equivalent. The COinS
  `span.Z3988` OpenURL blobs in the rendered HTML are the only machine-readable citations available
  — 49 of them on `Taupō Volcano`, with DOIs, bibcodes, authors and URLs.
- **`prop=extracts` cannot batch a full article.** `exlimit` caps at 20 but is silently forced to 1
  whenever `exintro` is absent, with a warning rather than an error. The gate is `exintro` alone;
  `explaintext`, `exchars` and `exsentences` do not unlock it.
- **`palimit` defaults to 10 across the whole batch, not per page.** Three titles at the default
  returned assessments for one and silently nothing for the other two. `palimit=max` is mandatory.
  Assessments are stored on the talk page but must be queried on the *subject* title — passing
  `Talk:X` returns no `pageassessments` key at all.
- **Hidden `All …` categories are not all maintenance issues.** `All Wikipedia articles written in
  New Zealand English` has 38,000 members. The quality flags use an explicit allow-list, and the
  project-independent WP:PIQA pseudo-project is what carries a single grade per article. A
  disambiguation page reports an **empty-string** class, not `Disambig`.
- **`watchers` absent means fewer than 30**, not zero — MediaWiki suppresses the count below that
  so unwatched pages cannot be identified.
- **WDQS never reports a timeout as HTTP 500.** An aggregate query past the 60-second deadline
  returns **504** `upstream request timeout` at ~65.5s; a streaming `SELECT` returns **200** with a
  body truncated mid-token and a `TimeoutException` trace appended — measured at **1,684,247,442
  bytes**, which is an out-of-memory kill for a 128 MB Worker if buffered. Response bodies are read
  through a byte cap for this reason.
- **A WDQS 400 carries the parser's own diagnosis**, `MalformedQueryException: Encountered "<EOF>" at
  line 1, column 35`, followed by ~40 frames of Java stack trace. The first is worth surfacing; the
  rest is not. A malformed query is never transient.
- **WDQS refuses writes outright**, so the read-only guard is defence in depth rather than the only
  barrier: `POST update=INSERT DATA {...}` returns **405 `Not writable.`**, and `query=INSERT DATA`
  is rejected by the parser, whose accepted start set is only
  `BASE | PREFIX | SELECT | CONSTRUCT | DESCRIBE | ASK`.
- **The scholarly graph split is by `instance of`, not by subject.** `?s wdt:P31 wd:Q13442814` is 0
  on main and 45,685,285 on scholarly, but `?work wdt:P921 wd:Q43642` returns rows on **both** — the
  main graph holds encyclopedia articles (Q13433827), articles (Q191067) and editions (Q3331189).
  `query-legacy-full.wikidata.org` no longer resolves; cross-graph questions federate from main with
  `SERVICE <https://query-scholarly.wikidata.org/sparql>`.
- **The Wikibase REST API has no `_language` parameter.** Passing one returns all ~180 languages with
  HTTP 200 and no warning. Bulk label lookup with a fallback is `wbgetentities` with
  `languagefallback=1`, capped at 50 ids; the fallback target is not always English — Q3621064 falls
  back to `mul`.
- **A quantity's unit is an entity URI, and its readable symbol is P5061**, not its label: Q712226 is
  "square kilometre" by label and `km²` by P5061. `"1"` is the unitless marker. One `wbgetentities`
  call with `props=claims` resolves every unit on a page at once.
- **Wikibase time values cannot be parsed with `Date`.** Month and day are legitimately `00` when
  unknown, days run to 31 in any month to allow "leap dates", and Q2 carries the year
  `-4540000000`. `precision` is what makes a value honest: 9 means the year only, so
  `+1986-00-00T00:00:00Z` means 1986, not 1 January 1986.
- **`list=backlinks` and `list=categorymembers` return HTTP 200 with an empty list** for a title that
  does not exist, so `prop=info` rides along on the same request to tell a typo from a real absence.

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
- "Which of these twenty articles are reliable enough to cite, and what do the shakiest ones
  actually cite?" (`wikimedia_get_page_metadata` for `assessment_class` and `maintenance` →
  `wikimedia_get_page` with `include_references` on the ones that need checking)
