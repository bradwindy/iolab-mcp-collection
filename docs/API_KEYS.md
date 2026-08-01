# Getting API keys

This collection wraps 24 upstream NZ public APIs. **14 of them need no key at all.** The other 10
account-gated APIs collapse into 9 credentials (NIWA's tides/UV/CO2 share one key; the Electricity
Authority needs two), entered through the portal (`https://<your-portal-domain>/servers/<slug>`), never
committed to the repo, and stored AES-256-GCM encrypted in the shared D1 database.

Three further servers wrap non-NZ APIs. `ia-mcp` and `wikimedia-mcp` accept **optional**
credentials that no tool requires; see "Optional credentials" at the end. `reddit-mcp` is the one
exception in this collection: it **requires** credentials, because Reddit has no anonymous API path
at all — see its section below.

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

## Keys you'll need to obtain (12 credentials)

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

### `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USERNAME` — Reddit Data API (`reddit-mcp`)

**Required — no tool on this server works without them.** Reddit returns HTTP 403 to every
unauthenticated request, including the old `.json` URLs (verified live: anonymous listing, comments
and search endpoints all 403, and `oauth.reddit.com` 403s without a bearer token). Reddit's own API
wiki states plainly that "clients must authenticate with OAuth2". This server uses the
application-only `client_credentials` grant, which involves no user login and reads only public
content.

**Reddit must approve your access first.** This is not a self-service key like every other entry on
this page. Reddit's
[Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
(updated 5 June 2026) states: *"Approval is required: You must request access and get explicit
approval before accessing any Reddit data through our API, and you must agree to comply with all
applicable terms."* Clicking **create app** without approval returns a link to that policy instead of
credentials. Approval is free for non-commercial use; the turnaround is not documented.

1. **Request access.** For a personal, non-commercial client whose use case the Developer Platform
   ("Devvit") does not cover — Devvit is for apps that run inside Reddit, not external API clients —
   file the developer request:
   [support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164&tf_42139884615700=api_request_type_developer_clone](https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164&tf_42139884615700=api_request_type_developer_clone).
   Describe the use case accurately: read-only, on-demand retrieval of specific posts and comment
   threads for personal reference; no bulk collection, no retention beyond a short cache, and no
   model training. That last point matters — the same policy prohibits using Reddit data "to train
   machine learning or AI models" without written approval. Retrieving a thread to read it is not
   training, but the clause is broadly worded.
2. **Create the app.** Once approved, go to
   [old.reddit.com/prefs/apps](https://old.reddit.com/prefs/apps) → **create another app**. Choose
   the **script** type: an "installed app" is a public client and is issued no secret, which the
   `client_credentials` grant requires. The redirect URI is unused by this grant but the form
   requires one, so `http://localhost:8080` is fine.
3. **Read off the two values.** The **client ID** is the unlabelled ~22-character string directly
   under the app name and the words "personal use script" — it is easy to miss because it has no
   caption. The **secret** is the field explicitly labelled `secret`.
4. **Enter them in the portal** at `/admin/servers/reddit-mcp`, along with your Reddit username
   (without the `u/` prefix) as `REDDIT_USERNAME`.
5. **Optionally register an app profile** at
   [developers.reddit.com/app-registration](https://developers.reddit.com/app-registration). This is
   a separate step concerned with *labelling* — giving the app a profile so users can distinguish it
   from a human account — and it presupposes an app that already exists.

The username is not used to authenticate. Reddit's API rules require a `User-Agent` of the form
`<platform>:<app id>:<version> (by /u/<username>)` and state that generic User-Agents are
"drastically limited"; it is stored as a credential rather than committed because this repo treats
operator identity as a secret, the same way it does `ACCESS_EMAIL` and `BASE_DOMAIN`.

Rate limit: Reddit's API wiki documents **60 requests per minute** for OAuth2 clients, reported per
response in `X-Ratelimit-Used` / `-Remaining` / `-Reset`. That is an app-wide budget, not per
connection, which is why this server issues upstream calls serially and caches aggressively.

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

This list covers exactly the APIs wrapped by this collection's 10 servers, not the full 24-API catalog
that informed its clustering (see [api-catalog](https://github.com/bradwindy/api-catalog) for the
complete inventory, including a few APIs that were deliberately left unwrapped as out of scope for a
personal research toolkit).
