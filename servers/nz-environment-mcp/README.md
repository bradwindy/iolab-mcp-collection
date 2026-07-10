# nz-environment-mcp

MCP server for NZ environmental hazard and climate research: [GeoNet](https://www.geonet.org.nz/)
earthquake/volcano feeds, the GeoNet FDSN seismic archive, and [NIWA](https://niwa.co.nz/) tide/UV/CO2
forecasting APIs. Part of the [nz-mcp-collection](../../README.md).

Read-only, stateless, deployed as a Cloudflare Worker behind a shared bearer token at
`https://nz-environment.mcp.yourdomain.com/mcp`.

## Tools

| Tool | Upstream | Key required | Description |
|---|---|---|---|
| `nz_env_search_quakes` | GeoNet API | No | Recent NZ earthquakes (last ~365 days, up to 100) filtered by minimum shaking intensity (MMI), magnitude, and data-quality flag. |
| `nz_env_get_quake_revision_history` | GeoNet API | No | Location/magnitude revision history for one earthquake by public ID — see if a preliminary estimate was later revised. |
| `nz_env_get_volcano_alert_levels` | GeoNet API | No | Current Volcanic Alert Level and aviation colour code for NZ's monitored volcanoes. |
| `nz_env_get_shaking_intensity` | GeoNet API | No | Measured (instrument) or reported (felt) shaking intensity, network-wide or scoped to one quake. |
| `nz_env_search_quake_history` | GeoNet FDSN | No | Historical earthquake search over any date range, filtered by magnitude, depth, bounding box, event type. |
| `nz_env_search_seismic_stations` | GeoNet FDSN | No | Seismic station network metadata by network/station code or bounding box. |
| `nz_env_get_waveform_download_url` | GeoNet FDSN | No | Escape hatch: builds a miniSEED waveform download URL (never fetches/inlines the binary data). |
| `nz_env_get_tide_forecast` | NIWA Tide Forecasting API | Yes | Tide height predictions over time for a coastal/ocean location. |
| `nz_env_get_uv_forecast` | NIWA UV API | Yes | UV Index forecast time series for a location. |
| `nz_env_get_co2_latest` | NIWA CO2 API | Yes | Latest atmospheric CO2 reading from the Baring Head clean-air station near Wellington. |

Every tool is read-only (`readOnlyHint: true`, `openWorldHint: true`), paginates where the result set
can be large, defaults to a concise `response_format` with a `detailed` opt-in, and returns a `notice`
field with guidance whenever a result was truncated. Geospatial results return point coordinates only
(GeoNet's quake/volcano/station data is already point data, never polygons) — raw waveform bodies and
rendered chart/UV images are never inlined, only linked.

## Upstream API keys

### GeoNet API and GeoNet FDSN Web Services — no key needed

Both are fully public, no signup, no rate-limit key. See the
[GeoNet data policy](https://www.geonet.org.nz/data/policy) for the CC BY 3.0 NZ attribution terms this
server includes in every response.

### NIWA Tide, UV, and CO2 APIs — one shared `NIWA_API_KEY`

1. Go to the [NIWA developer portal](https://developer.niwa.co.nz/) and sign in / create an account.
2. Follow [Get started](https://developer.niwa.co.nz/get-started): register an "app" name to generate an
   API key.
3. From your app's dashboard, subscribe that same app to the **Tide API**, **UV API**, and **CO2** products.
4. Set the resulting key on this server via your deployed portal at `<your PORTAL_URL>/servers/nz-environment-mcp`
   (or directly with `setCredential` from `@nz-mcp/credentials`) under the key name `NIWA_API_KEY`.

**Design note on "one key or three":** NIWA's own catalog wording is identical across the Tide, UV, and
CO2 API entries ("Sign in to the NIWA developer portal. Register an app name and generate an API key.").
The developer portal's backend also lists Tide, UV, CO2 (and SolarView, FPAT) as separate *products*
under the single `niwa-niwaapis` portal site/account. That combination — one app, many subscribable
products — is the standard pattern for the API-management platform NIWA's portal runs on (an
Axway/IBM-APIC/Akana-style "liveportal", confirmed by inspecting the portal's own backend JSON API at
`/portals/api/sites/niwa-niwaapis/liveportal/apis`): one app registration yields one client key, and that
key is reused across every product the app is subscribed to. We could **not** fully confirm this from
NIWA's own prose documentation — `developer.niwa.co.nz` is a client-rendered single-page app that returns
only an empty `<app>` shell to non-browser HTTP clients (confirmed live; also checked the Wayback Machine,
which only has the same un-rendered shell archived). Given the identical wording and shared-portal
evidence, this server uses a single `NIWA_API_KEY` credential for all three NIWA tools. If your account
ever needs a second, product-specific key, split the credential per tool (`NIWA_TIDES_API_KEY`,
`NIWA_UV_API_KEY`, `NIWA_CO2_API_KEY`) and update `src/clients/niwaCredentials.ts` accordingly.

Auth mechanics: the JSON data routes (`/tides/data`, `/uv/data`, `/co2/info/baringhead.txt`) send the key
via the `x-apikey` header — confirmed against NIWA's own `tide-examples` PHP script and two independent
open-source Tide API clients on GitHub (`nzben/niwa-api-client`, `muxa/home-assistant-niwa-tides`), which
both use that header rather than the `apikey` query-string form shown in the catalog's canned curl
examples. The rendered chart/image routes (tide chart, UV current/max images, CO2 daily chart) can only be
authenticated via the `apikey` query parameter, because a browser or `<img>` tag loading that URL directly
can't attach a custom header — so `chart_url`/`image_urls` in `detailed` responses embed the key in the
URL. Every response that includes one of these URLs says so explicitly in its `notice` field: **treat
those URLs as secrets**.

## Open research questions / defensive design choices

- **NIWA UV `/data` JSON shape** and **NIWA CO2 `/info/baringhead.txt` text format** could not be
  confirmed against primary docs (same SPA-blocking issue as above) or any third-party client — unlike the
  Tide API, no public code wrapping these two specific routes could be found. Both tools are written
  defensively:
  - `nz_env_get_uv_forecast` looks for a `values`/`data`/`forecast`/`series` array in the response (the
    convention NIWA's own Tide API uses); if none match, it falls back to returning the whole raw payload
    verbatim under `forecast[0].raw_response` and says so in `notice`.
  - `nz_env_get_co2_latest` best-effort parses `key: value` / `key = value` lines from the text into
    `parsed`, and always also returns the verbatim `raw_text` so nothing is lost regardless of the actual
    format. If `parsed` comes back empty, `notice` says so.

  Once a real NIWA key is available, smoke-test both routes and adjust `extractForecastSeries()` in
  `src/tools/getUvForecast.ts` / `parseInfoText()` in `src/clients/niwaCo2.ts` if the real shape differs.

- **GeoNet `/quake` feed window**: confirmed live and via GeoNet's own docs
  (`https://api.geonet.org.nz/`) that it returns "quakes possibly felt in the New Zealand region during
  the last 365 days up to a maximum of 100 quakes" and that `MMI` is a required query parameter (a request
  without it returns `400`). `nz_env_search_quakes` defaults `min_mmi` to 3.

- **FDSN event/station services have no server-side pagination** — confirmed via both services'
  `application.wadl`. `nz_env_search_quake_history` and `nz_env_search_seismic_stations` fetch the full
  (GeoNet-capped) result set per query and paginate client-side.

## Example research questions

- "Has there been any earthquake swarm activity or a rising Volcanic Alert Level near Whakaari/White
  Island in the last week, and what's the current shaking intensity being reported nearby?"
- "Find every M5+ earthquake within 50km of Wellington between 2016 and 2020, and check whether any of
  their magnitude estimates were later revised."
- "What's today's UV forecast and tide pattern for Mount Maunganui, and how does the current atmospheric
  CO2 reading from Baring Head compare to ten years ago?"

## Development

```bash
pnpm install          # from the repo root — installs all workspace packages
pnpm --filter @nz-mcp/nz-environment-mcp typecheck
pnpm --filter @nz-mcp/nz-environment-mcp test
pnpm --filter @nz-mcp/nz-environment-mcp dev
```

Copy `.dev.vars.example` to `.dev.vars` and fill in a real `MCP_SHARED_TOKEN` and a generated
`ENCRYPTION_KEY` before running `wrangler dev` locally.
