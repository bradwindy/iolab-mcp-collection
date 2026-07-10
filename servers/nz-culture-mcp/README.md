# nz-culture-mcp

MCP server for NZ digital heritage & museum collections research. Wraps two upstream APIs:

- **[DigitalNZ](https://digitalnz.org/developers/api-docs-v3)** — cross-collection metadata search
  aggregating 30M+ records from NZ libraries, museums, archives, and universities. Public reads,
  **no API key required**.
- **[Te Papa Collections API](https://data.tepapa.govt.nz/docs/)** — structured search over the
  Museum of New Zealand Te Papa Tongarewa's 800,000+ collection items (objects, specimens, people,
  places, taxa, publications). **Requires an API key.**

Every tool is read-only, paginated where it returns a list, defaults to a concise response shape,
and includes a `source`/license attribution note per response.

## Tools

| Tool | Description | Credential |
|---|---|---|
| `nz_culture_search_digitalnz` | Free-text search across DigitalNZ's aggregated metadata index, with optional category and geographic-bbox filters and optional facet counts. | none |
| `nz_culture_get_digitalnz_record` | Fetch full metadata for a single DigitalNZ record by numeric id. | none |
| `nz_culture_search_te_papa` | Search Te Papa's collections by keyword, optionally scoped to one entity type (Object, Specimen, Agent, Taxon, Place, Topic, Category, Publication). | `TE_PAPA_API_KEY` |
| `nz_culture_get_te_papa_item` | Fetch full metadata for a single Te Papa item by resource type and id. | `TE_PAPA_API_KEY` |

## Getting a Te Papa API key

DigitalNZ needs no signup at all. Te Papa does:

1. Go to the [API browser](https://data.tepapa.govt.nz/docs/apibrowser.html) to explore the API
   interactively with a temporary **guest key** (issued per-session, expires after about an hour —
   fine for exploring the browser, not usable as a stored credential).
2. For persistent access, register your own key at
   [data.tepapa.govt.nz/docs/register.html](https://data.tepapa.govt.nz/docs/register.html). The
   form asks for email, first/last name, an "API key description", and your organisation, and
   requires accepting Te Papa's [API terms of use](https://www.tepapa.govt.nz/api-terms-of-use).
   Registration issues a permanent key sent to the registered email (no numeric quota is published;
   the API enforces a **10 requests/second** rate limit and returns HTTP 429 if exceeded — this
   server's client already backs off and retries on 429).
3. Store the issued key as this server's `TE_PAPA_API_KEY` credential via the portal at
   `https://mcp.iolab.nz/servers/nz-culture-mcp`. Any tool call made before a key is stored returns
   an actionable `missingCredentialError` pointing back to that portal URL.

## Example research questions

- "Search DigitalNZ for newspaper articles about the 1931 Hawke's Bay earthquake, then pull the
  full metadata for the most-cited-looking one."
- "What does Te Papa hold on Apteryx owenii (little spotted kiwi) — both the taxon record and any
  specimens or Māori taonga referencing it?"
- "Find images of kiwi feather cloaks (kahu kiwi) in both DigitalNZ and Te Papa's collections, and
  compare what licensing/reuse rights are attached to each."

## Research notes / things confirmed live

- **DigitalNZ** (`https://api.digitalnz.org/v3`) was exercised live end-to-end: `/records.json`
  (free-text `text`, category filtering via `and[category][]=`, `geo_bbox`, `facets`/
  `facets_per_page`, and a `fields` param that slims the response to a requested field list) and
  `/records/{id}.json` (wraps the same record shape under a `record` key). Confirmed `per_page` is
  capped at 100 server-side (HTTP 400 above that, matching the published docs).
- **Te Papa**: the API catalog entry lists `/api/v1/search` as the search endpoint, but that path
  returned `403 Forbidden` in live testing. The actual, working base path — confirmed via the
  [collections-api wiki](https://github.com/te-papa/collections-api/wiki/Getting-started) and by
  hitting it live — is **`https://data.tepapa.govt.nz/collection/search`** (and
  `/collection/{resource}/{id}` for fetch-by-id), authenticated with an `x-api-key` header for a
  permanent key. This server implements the corrected path; the catalog entry should be updated.
- To validate the corrected Te Papa endpoint without a stored credential, this server's build
  process used the API's own **guest-token flow**: any unauthenticated request to
  `/collection/search` returns a 401 whose body includes a short-lived `guestToken` JWT, usable as
  a `Bearer` token for about an hour. That confirmed the real response shape (`results` /
  `facets` / `_metadata.resultset.{count,from,size,truncated}`) and the real `fields`-param
  behaviour, including on nested arrays like `hasRepresentation`. **This guest-token flow is not
  used by the deployed server** — it only takes a permanent `x-api-key` via the `TE_PAPA_API_KEY`
  credential — but it is how "live verification" was done here without a self-registered key.
- **Important, easy-to-miss API quirk**: Te Papa ids are only unique *within* a resource type, not
  globally. For example id `7320` is the Taxon "Little Spotted Kiwi, Apteryx owenii" under
  `/collection/taxon/7320`, but an entirely unrelated moss Specimen under `/collection/object/7320`.
  `nz_culture_get_te_papa_item` therefore requires both `resource_type` and `id` — never just an
  id — and `nz_culture_search_te_papa` results carry a `type` field to tell you which resource path
  a given hit's id belongs to.
- The 10 REST resource paths documented in the wiki (`object`, `agent`, `place`, `taxon`,
  `document`, `topic`, `group`, `fieldcollection`, `media`, `category`) don't map 1:1 onto the
  `type:` values usable in search filters. A facet aggregation across the whole collection surfaced
  only `Object`, `Specimen`, `Taxon`, `Topic`, `Person`, `Organisation`, `Place`, `Category`,
  `Publication`, and `Collaboration` as standalone, top-level-searchable types — `media`, `group`,
  and `fieldcollection` exist as fetch-by-id paths for entities embedded inside other records
  (an object's own images, a taxonomic/agent grouping, a collecting event) rather than as things
  you'd search for directly. `nz_culture_search_te_papa`'s `collection` filter therefore only
  offers the confirmed standalone types (plus an `Agent` convenience alias covering both `Person`
  and `Organisation`, matching the wiki's own grouping and the `/agent` fetch path), while
  `nz_culture_get_te_papa_item`'s `resource_type` offers the full path list, since all ten
  resolved successfully in live spot-checks (`/agent/{id}`, `/place/{id}`, `/fieldcollection/{id}`,
  `/category/{id}`, `/taxon/{id}`, `/object/{id}`, `/document/{id}`, `/media/{id}` all returned
  200; `/publication/{id}` does **not** exist as a path — Publication-type items live under
  `/document/{id}`).
- Only 4 tools are implemented rather than the 5–8 the brief suggests as a typical range: each
  upstream API genuinely only has two meaningfully-different operations (search, get-by-id), and
  Te Papa's own query syntax (quoted phrases, wildcards, field search, boolean operators, ranges)
  is already forwarded as-is through the `query` param, so a separate raw-query escape hatch would
  just duplicate `nz_culture_search_te_papa`. Facets are exposed as an opt-in field on
  `nz_culture_search_digitalnz` rather than a separate tool, per the "search-shaped, not 1:1
  endpoint wraps" guidance.
