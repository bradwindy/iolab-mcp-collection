# Getting API keys

This collection wraps 24 upstream NZ public APIs. **14 of them need no key at all.** The other 10
account-gated APIs collapse into 9 credentials (NIWA's tides/UV/CO2 share one key; the Electricity
Authority needs two), entered through the portal (`https://<your-portal-domain>/servers/<slug>`), never
committed to the repo, and stored AES-256-GCM encrypted in the shared D1 database.

Two further servers — `ia-mcp` and `wikimedia-mcp` — wrap non-NZ APIs and accept **optional**
credentials that no tool requires; see "Optional credentials" at the end.

Until you set a given required key, the tools that need it return a clear error telling you exactly
which key is missing and where to set it — everything else works immediately after deploy.

## No key required (14 APIs, work immediately)

| API | Server |
|---|---|
| DigitalNZ | `nz-culture-mcp` |
| GeoNet | `nz-environment-mcp` |
| GeoNet FDSN Web Services | `nz-environment-mcp` |
| Charities Services Open Data | `nz-govt-mcp` |
| data.govt.nz APIs | `nz-govt-mcp` |
| Auckland Council Open Data Search API | `nz-govt-mcp` |
| Education Counts School Directory API | `nz-govt-mcp` |
| Education Counts Early Childhood Services Directory API | `nz-govt-mcp` |
| Canterbury Maps Public Server | `nz-geo-mcp` |
| NZTA Traffic and Travel APIs | `nz-transport-mcp` |
| NZTA TMS Daily Traffic Counts API | `nz-transport-mcp` |
| NZTA Motor Vehicle Register API | `nz-transport-mcp` |
| NZTA Driver Licence Holders Dataset API | `nz-transport-mcp` |
| Rates API | `nz-markets-mcp` |

## Keys you'll need to obtain (9 credentials)

### `TE_PAPA_API_KEY` — Te Papa Collections API (`nz-culture-mcp`)

1. Visit [data.tepapa.govt.nz/docs/register.html](https://data.tepapa.govt.nz/docs/register.html) and
   register for an API key (a guest key is also available in their API browser for quick exploration,
   but a self-registered key is recommended for regular use).
2. Enter it in the portal at `/admin/servers/nz-culture-mcp` as `TE_PAPA_API_KEY`.

### `STATS_NZ_SUBSCRIPTION_KEY` — Stats NZ Aotearoa Data Explorer (`nz-stats-mcp`)

1. Create an account at [portal.apis.stats.govt.nz](https://portal.apis.stats.govt.nz/).
2. Follow [How to subscribe](https://portal.apis.stats.govt.nz/how-to-subscribe) to subscribe to the
   relevant API product and generate a subscription key.
3. Enter it in the portal at `/admin/servers/nz-stats-mcp` as `STATS_NZ_SUBSCRIPTION_KEY`.

### `LINZ_API_KEY` — LINZ Data Service (`nz-geo-mcp`)

1. Create a LINZ Data Service account and follow
   [Create an API key](https://www.linz.govt.nz/guidance/data-service/linz-data-service-guide/web-services/creating-api-key).
2. Enter it in the portal at `/admin/servers/nz-geo-mcp` as `LINZ_API_KEY`.

### `LINZ_BASEMAPS_API_KEY` — LINZ Basemaps (`nz-geo-mcp`)

A **separate** credential system from LINZ Data Service, even though both are run by LINZ.

1. Follow [Get started](https://basemaps.linz.govt.nz/docs/user-guide/_get-started/) — a no-signup,
   90-day "dynamic" key is issued automatically when you visit basemaps.linz.govt.nz, or email
   basemaps@linz.govt.nz for a non-expiring Developer key for production use.
2. Enter it in the portal at `/admin/servers/nz-geo-mcp` as `LINZ_BASEMAPS_API_KEY`.

### `NIWA_API_KEY` — NIWA Tides / UV / CO2 (`nz-environment-mcp`)

One key covers all three NIWA APIs this server wraps.

1. Sign in to the [NIWA developer portal](https://developer.niwa.co.nz/get-started), register an app
   name, and generate an API key.
2. Enter it in the portal at `/admin/servers/nz-environment-mcp` as `NIWA_API_KEY`.

### `AT_SUBSCRIPTION_KEY` — Auckland Transport Developer APIs (`nz-transport-mcp`)

1. Sign up at the [AT developer portal](https://dev-portal.at.govt.nz/) and subscribe to the Realtime
   and GTFS API products to get a subscription key. Free tier limits: 600 calls/minute, 35,000/week —
   this server caches the realtime feeds to stay well inside that budget.
2. Enter it in the portal at `/admin/servers/nz-transport-mcp` as `AT_SUBSCRIPTION_KEY`.

### `NZXPLORER_API_KEY` — NZXplorer (`nz-markets-mcp`)

1. Create an account at [nzxplorer.co.nz](https://nzxplorer.co.nz/), then go to
   **Settings → API & Developer** and generate a key. Free tier: 10 requests/minute.
2. Enter it in the portal at `/admin/servers/nz-markets-mcp` as `NZXPLORER_API_KEY`.

### `EA_ICP_API_KEY` and `EA_DISPATCH_API_KEY` — Electricity Authority EMI APIs (`nz-markets-mcp`)

**Two separate** subscription keys — Azure API Management issues one key per product, not per account.

1. Sign up as a member of the Electricity Authority API community at
   [emi.developer.azure-api.net/signup](https://emi.developer.azure-api.net/signup).
2. Subscribe to the **ICP connection data** product for `EA_ICP_API_KEY`, and separately to the
   **Wholesale market prices** product for `EA_DISPATCH_API_KEY` (this is what gates the real-time
   dispatch tool — the product is not named "dispatch"). Both require manual EA admin approval.
3. Enter both in the portal at `/admin/servers/nz-markets-mcp`.

## Optional credentials (nothing needs these)

Both entries below are wired through the same portal and store as the keys above, but every tool on
these servers works fully without them. Neither has been verified against a real credential — per
[`ADDING_A_SERVER.md`](ADDING_A_SERVER.md) §2 no agent may sign up for or obtain a key, so both paths
are written defensively against documented behaviour and stay unexercised until you enter one.

### `IA_S3_ACCESS_KEY` / `IA_S3_SECRET_KEY` — archive.org (`ia-mcp`)

**Optional, and not known to change anything.** archive.org's automated-access docs describe an IA-S3
`Authorization: LOW <access>:<secret>` header for "higher rate limits", but live testing found no
evidence read endpoints treat it differently, and IA's own documentation frames rate limiting around
uploads rather than reads. Wired in anyway in case that assumption is wrong.

1. Generate a pair at [archive.org/account/s3.php](https://archive.org/account/s3.php).
2. Enter both in the portal at `/admin/servers/ia-mcp`.

### `WIKIMEDIA_OAUTH_TOKEN` — Wikimedia OAuth 2.0 (`wikimedia-mcp`)

**Optional, and almost certainly unnecessary.** Wikimedia's 2026 rate limits give an unauthenticated
client sending a policy-compliant `User-Agent` **200 requests/minute** (against 10 for an
"unidentified" one — which is why the compliant header is mandatory, not optional). Authenticating
raises that to 200–2,000/minute and lifts the Action API's concurrency cap from 1 to 3. 200/minute is
far beyond interactive use, so no tool requires it and none returns a missing-credential error.

1. Register an **owner-only** consumer at
   [Special:OAuthConsumerRegistration](https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose)
   — owner-only is the simplest flow and is approved immediately. It is free.
2. Enter the resulting access token in the portal at `/admin/servers/wikimedia-mcp` as
   `WIKIMEDIA_OAUTH_TOKEN`.

## A note on scope

This list covers exactly the APIs wrapped by this collection's 9 servers, not the full 24-API catalog
that informed its clustering (see [api-catalog](https://github.com/bradwindy/api-catalog) for the
complete inventory, including a few APIs that were deliberately left unwrapped as out of scope for a
personal research toolkit).
