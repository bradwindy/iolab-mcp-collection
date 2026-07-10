# nz-markets-mcp

MCP server for NZ lending-rate, capital-market, and electricity-market research. Wraps three
upstream APIs:

1. **[Rates API](https://ratesapi.nz/)** — current NZ mortgage, personal loan, car loan, and
   credit card rates by institution. Public, no API key.
2. **[NZXplorer API](https://nzxplorer.co.nz/developers)** — NZX-listed company profiles and
   market announcements. Requires a free NZXplorer API key.
3. **[Electricity Authority EMI APIs](https://www.ea.govt.nz/data-and-insights/tools-and-apis/)** —
   ICP (installation control point) connection lookups and near-real-time electricity dispatch
   prices. Requires two separate EA subscription keys.

## Tools

| Tool | Description | Upstream | Key required |
|---|---|---|---|
| `nz_markets_get_mortgage_rates` | List current mortgage rates by institution and term. | Rates API | No |
| `nz_markets_get_consumer_loan_rates` | List current personal loan, car loan, or credit card rates by institution. | Rates API | No |
| `nz_markets_search_companies` | Search/browse NZX-listed companies by name, ticker, or sector. | NZXplorer | Yes |
| `nz_markets_get_company` | Fetch one NZX company's profile by ticker. | NZXplorer | Yes |
| `nz_markets_search_market_announcements` | Full-text search NZX market announcements by keyword, ticker, type, or date range. | NZXplorer | Yes |
| `nz_markets_get_electricity_dispatch` | Get near-real-time dispatch prices, generation, and demand by grid connection point. | Electricity Authority | Yes |
| `nz_markets_search_icp_connections` | Look up electricity connection (ICP) data by exact ICP number or street address. | Electricity Authority | Yes |

Every tool follows the collection's conventions: `response_format: "concise" | "detailed"`
(default concise), `limit`/`offset` pagination with `total_count`/`has_more`/`next_offset`,
a `notice` field on truncated results, and a `source`/`url` `attribution` object.

## Upstream API keys

This server needs **three** separate credentials, configured through the portal (see
`@nz-mcp/credentials` — values are AES-256-GCM encrypted at rest in the shared `CREDENTIALS_DB`
D1 database, keyed by this server's slug `nz-markets-mcp`). Tools that need a missing key return
an actionable tool error telling you which key to set and where.

### 1. `NZXPLORER_API_KEY` — NZXplorer

1. Create an account at [nzxplorer.co.nz](https://nzxplorer.co.nz/).
2. Go to **Settings → API & Developer** and generate a key.
3. Free tier: 10 requests/minute. This server caches aggressively (the whole ~131-company
   roster is fetched once and cached for 24h; announcement searches are not cached) and retries
   sparingly (max 2 attempts) to stay well inside that budget.
4. Reference: [nzxplorer.co.nz/developers](https://nzxplorer.co.nz/developers).

### 2. `EA_ICP_API_KEY` — Electricity Authority, "ICP connection data" product

1. Sign up as a member of the Electricity Authority API community at
   [emi.developer.azure-api.net/signup](https://emi.developer.azure-api.net/signup).
2. Subscribe to the **ICP connection data** product. Approval is required — the EA admin
   manually approves subscription requests.
3. Once approved, copy your subscription key from the developer portal.
4. Reference: [ea.govt.nz — APIs and tools](https://www.ea.govt.nz/data-and-insights/tools-and-apis/).

### 3. `EA_DISPATCH_API_KEY` — Electricity Authority, "Wholesale market prices" product

1. Same developer-portal account as above, but subscribe to the separate **Wholesale market
   prices** product (this is what gates the real-time dispatch API — the product is not named
   "dispatch"). Approval is required.
2. Copy the resulting subscription key — it is a **different** key from `EA_ICP_API_KEY` because
   Azure API Management issues one subscription key per product, not one per developer account.

## Example research questions

- "What's the lowest 1-year fixed mortgage rate available right now, and who offers it?"
  (`nz_markets_get_mortgage_rates`)
- "Show me every dividend and full-year-result announcement Fisher & Paykel Healthcare has made
  in the last 12 months." (`nz_markets_search_market_announcements`)
- "What was the wholesale electricity price at Haywards (HAY2201) at 5pm yesterday, and what's
  the ICP connection data for 12 Queen Street, Auckland?" (`nz_markets_get_electricity_dispatch` +
  `nz_markets_search_icp_connections`)

## Research notes / open questions

- **Electricity Authority base URL correction**: the api-catalog entry and the EA's own docs page
  list `https://emi.developer.azure-api.net` as the base URL. That host only serves the
  interactive developer-portal SPA — confirmed live, every REST-shaped path 404s there. The
  actual API gateway is `https://emi.azure-api.net` (confirmed live: returns
  `401 Access denied due to missing subscription key` with a
  `WWW-Authenticate: AzureApiManagementKey ... name="Ocp-Apim-Subscription-Key"` header for the
  same paths that 404 on the portal host). This was found by reading the portal's own
  `/config.json` (which points its frontend at `emi.management.azure-api.net`) and then querying
  that content API's public, unauthenticated `/apis`, `/apis/{id}/operations`, and `/products`
  sub-resources directly, which mirror the exact operation definitions the interactive docs page
  would otherwise only render via client-side JavaScript.
- **ICP connection data is Segment-versioned**: the gateway path needs a `/v2/` segment
  (`/ICPConnectionData/v2/search/`, `/ICPConnectionData/v2/single/`) — not visible anywhere in
  the docs' rendered text, only discoverable by noting the API's `apiVersionSet` has
  `versioningScheme: "Segment"` and then testing that the unversioned path 404s while the
  versioned one reaches the operation.
  Real-time dispatch has no version segment (`/real-time-dispatch/`).
- **Two separate EA subscription keys are required**, not one — confirmed via the content API's
  `/products` list, which shows exactly two products ("ICP connection data" and "Wholesale market
  prices"), each with `subscriptionRequired: true` and `approvalRequired: true`. Azure API
  Management issues one subscription key per product, so a single EA developer-portal account
  yields two distinct keys.
- **ICP search response shape is ambiguous**: the documented example response for the "Search"
  operation shows a single object, but its own description says an address search "will likely
  get multiple addresses returned." Designed defensively: the client normalizes either a bare
  object or an array into an array before returning.
- **NZXplorer's `/companies` endpoint has no `sector` query param** in its current live OpenAPI
  spec (`nzxplorer.co.nz/openapi.json`, version 1.157.0), even though the api-catalog's sample
  request shows `?sector=Technology` and `/governance`/`/metrics`/`/dividends` *do* have a
  `sector` param. Since NZX's entire listed universe is only 131 companies (well under the `limit`
  param's max of 500), this server fetches the whole roster once, caches it for 24h, and filters
  `query`/`sector` client-side from that snapshot — this also avoids fragmenting the cache per
  distinct search string against a 10 req/min free tier.
- **NZXplorer announcement field names are unconfirmed**: `/announcements` has no dedicated
  response schema in the OpenAPI spec (just a generic, untyped envelope), and this server was
  never given a live API key to test against. The concise view defensively tries several
  plausible field-name variants (`id`/`announcement_id`, `title`/`headline`, etc.); the detailed
  view always includes the complete raw record regardless, so nothing is lost if those guesses
  are wrong.
- **NZXplorer `/companies/{ticker}?include=all` nested field names are similarly unconfirmed** —
  the operation's response schema is a generic envelope. The concise view surfaces only the
  fields documented on the separate `CompanySummary` schema (which the spec confirms are present
  on this endpoint too); the detailed view includes everything else from the raw response
  verbatim under a `raw` key.
- **Rates API institution/issuer ids** are always `institution:kebab-case-slug` or
  `issuer:kebab-case-slug` — confirmed live across all 35 mortgage lenders and 30+ credit-card
  issuers. This server accepts a free-text name (e.g. "Co-operative Bank") and normalizes it, so
  callers never need to know the exact slug.
