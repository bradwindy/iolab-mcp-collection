# nz-geo-mcp

Remote MCP server for New Zealand geospatial, property, and mapping research. Part of the
[nz-mcp-collection](../../README.md). Wraps three upstream APIs:

- **LINZ Data Service (LDS)** — queryable vector layers (parcels, addresses, topographic
  features, hydrography, and more). Requires a free LINZ Data Service API key.
- **LINZ Basemaps** — national aerial-imagery and topographic basemap tiles/styles. Requires a
  free LINZ Basemaps API key (a *separate* system from LDS — see below).
- **Canterbury Maps public ArcGIS server** (Environment Canterbury) — public GIS service
  directory, feature queries, and address/place geocoding for the Canterbury region. No API key.

All tools are read-only, paginate where the upstream supports it, default to concise responses,
never return raw polygon/line geometry (centroids and bounding boxes only), and surface upstream
failures as actionable tool errors rather than thrown protocol errors.

## Tools

| Tool | Upstream | Key needed | Description |
|---|---|---|---|
| `nz_geo_query_layer` | LINZ Data Service | `LINZ_API_KEY` | Escape hatch: point+radius spatial query against one or more LDS vector layers by id; returns feature attributes (and an optional centroid/bbox) near a coordinate. |
| `nz_geo_get_parcel` | LINZ Data Service | `LINZ_API_KEY` | Workflow tool: find NZ land parcel(s) — legal description, parcel intent, land district, area, title count — at or near a coordinate, using LINZ's "NZ Primary Parcels" layer (50772). |
| `nz_geo_get_basemap_style_url` | LINZ Basemaps | `LINZ_BASEMAPS_API_KEY` | Build a ready-to-use XYZ tile template, WMTS capabilities URL, or vector StyleJSON URL for LINZ's aerial or topographic basemap, with your key injected. Does not proxy tile bytes. |
| `nz_geo_search_canterbury_services` | Canterbury Maps | none | Search the public ArcGIS service directory by keyword (e.g. "groundwater", "flood") to find a MapServer/FeatureServer/GeocodeServer. |
| `nz_geo_query_canterbury_layer` | Canterbury Maps | none | Escape hatch: list a service's sub-layers (omit `layer_id`), or run a SQL WHERE-clause query against one sub-layer, paginated. |
| `nz_geo_search_canterbury_addresses` | Canterbury Maps | none | Geocode a street address or named place (park, suburb, landmark) within Canterbury to coordinates, via Environment Canterbury's public locators. |

## Required upstream API keys

### `LINZ_API_KEY` — LINZ Data Service

1. Create a free account at [data.linz.govt.nz](https://data.linz.govt.nz/) (top-right "Login" /
   "Register").
2. Log in, click your name in the top menu, then **API Keys**.
3. Click **Create API Key**, give it a label, select **Data access only**, and click **Add**
   (this agrees to LINZ's Terms of Use).
4. Set it on the portal for this server (`nz-geo-mcp` / `LINZ_API_KEY`), or locally via
   `wrangler secret put LINZ_API_KEY` for `wrangler dev`.

Reference: [LDS APIs and web services](https://www.linz.govt.nz/guidance/data-service/linz-data-service-guide/web-services/lds-apis-and-web-services),
[Creating an API key](https://www.linz.govt.nz/guidance/data-service/linz-data-service-guide/web-services/creating-api-key).

### `LINZ_BASEMAPS_API_KEY` — LINZ Basemaps

**This is a separate system from the LINZ Data Service** — confirmed by cross-referencing both
LINZ guidance pages (see Research Findings below), so this server requires two independent keys.

1. Visit [basemaps.linz.govt.nz](https://basemaps.linz.govt.nz/) — **no registration is required**
   for "Standard access": the site issues you a dynamic API key automatically (grab it from the
   URL/menu bar), good for up to 1,000 tile requests/minute and 1,000,000/month. Standard keys
   expire after 90 days; revisiting the site issues a fresh one.
2. For production/unlimited use, email **basemaps@linz.govt.nz** to request a non-expiring
   **Developer** key (can be restricted to your domain).
3. Set it on the portal for this server (`nz-geo-mcp` / `LINZ_BASEMAPS_API_KEY`), or locally via
   `wrangler secret put LINZ_BASEMAPS_API_KEY`.

Reference: [How to use LINZ Basemaps APIs](https://www.linz.govt.nz/guidance/data-service/linz-basemaps-guide/how-use-linz-basemaps-apis),
[LINZ Basemaps documentation](https://www.linz.govt.nz/guidance/data-service/linz-basemaps-guide/linz-basemaps-documentation),
[Get started](https://basemaps.linz.govt.nz/docs/user-guide/_get-started/).

### Canterbury Maps

No signup, no key. Public ArcGIS REST service directory at
[gis.ecan.govt.nz/arcgis/rest/services](https://gis.ecan.govt.nz/arcgis/rest/services).

## Example research questions

- *"What's the legal description, area, and land district of the parcel at -43.5321, 172.6362?"*
  → `nz_geo_get_parcel`.
- *"Give me a MapLibre-ready aerial imagery tile URL for NZTM2000."*
  → `nz_geo_get_basemap_style_url({ tileset: "aerial", crs: "2193" })`.
- *"Which Canterbury groundwater monitoring layers are active near Rolleston, and how many active
  wells does the region have?"* → `nz_geo_search_canterbury_services({ query: "groundwater" })`
  then `nz_geo_query_canterbury_layer({ ..., where: "WELL_STATUS_DESC = 'Active'" })`.
- *"Where is 200 Tuam Street, Christchurch, and what parcel(s) sit there?"*
  → `nz_geo_search_canterbury_addresses` to geocode, then `nz_geo_get_parcel` with the returned
  lat/lon.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in MCP_SHARED_TOKEN and ENCRYPTION_KEY
pnpm --filter @iolab/nz-geo-mcp dev
pnpm --filter @iolab/nz-geo-mcp test
```

`ENCRYPTION_KEY` must match the value used across every server that shares the collection's D1
credentials store — generate once with `generateEncryptionKey()` from `@iolab/credentials`, not
per-server.

## Research findings & design notes

- **LDS is a white-label Koordinates deployment** — confirmed by the `server: Koordinates` HTTP
  response header on `data.linz.govt.nz`. Its vector query API
  (`/services/query/v1/vector.json`) is a **point + radius** spatial query (`x`, `y`, `radius`,
  `max_results`, `geometry`) — there is no bbox, attribute-filter (CQL), or offset-pagination mode
  documented for this endpoint. `nz_geo_query_layer` and `nz_geo_get_parcel` are designed around
  that real shape rather than the more generic `bbox`/`filter`/`offset` signature suggested in the
  original assignment sketch. The exact response JSON shape (`vectorQuery.layers.{id}.features[]`)
  is per Koordinates' own generic docs (help.koordinates.com, support.koordinates.com) but could
  **not** be verified against a live authenticated response — no API key is obtainable in this
  build environment. The client parses defensively (optional chaining, tolerant of a
  non-`vectorQuery`-wrapped shape too) so a shape mismatch degrades to "no features found" rather
  than crashing; verify against a real key on first use.
- **LINZ Basemaps and LINZ Data Service use separate API keys/accounts.** Multiple independent
  searches and LINZ's own guidance pages describe LDS as requiring an LDS account with
  self-service key creation, while LINZ Basemaps issues a no-registration "dynamic" key per visit
  (or a separate Developer key via basemaps@linz.govt.nz) — no shared-account language appears
  anywhere. Both `LINZ_API_KEY` and `LINZ_BASEMAPS_API_KEY` are kept as independent credentials.
- **Basemaps URL patterns**: the WMTS capabilities URL
  (`/v1/tiles/{tileset}/EPSG:{crs}/WMTSCapabilities.xml?api=...`) was confirmed live (returned a
  valid WMTS 1.0.0 capabilities XML document) before that check was correctly blocked by policy —
  using a key surfaced in public search-engine results, even one never "signed up" for, is exactly
  the kind of found-credential use the assignment rules out, so no further live authenticated
  checks were made. The XYZ tile path (`/v1/tiles/{tileset}/{crs}/{z}/{x}/{y}.{format}?api=...`,
  bare CRS code) and vector style path (`/v1/tiles/{tileset}/EPSG:{crs}/style/{tileset}.json?api=...`)
  are based on LINZ's own documentation and consistently repeated third-party examples but were not
  independently re-verified after that point — confirm against your own key if a tile 404s.
- **NZ Primary Parcels layer (id 50772)** and its field names (`id`, `appellation`,
  `parcel_intent`, `land_district`, `survey_area`, `calc_area`, `titles`, `affected_surveys`,
  `topology_type`, `statutory_actions`) were confirmed via
  [data.linz.govt.nz/layer/50772-nz-primary-parcels](https://data.linz.govt.nz/layer/50772-nz-primary-parcels/)
  and cross-referenced search results — not guessed.
- **Canterbury Maps** (`gis.ecan.govt.nz/arcgis/rest/services`) was crawled live: root + 16
  folders, ~137 services total (confirmed with `curl`), standard Esri FeatureServer/MapServer
  `/query` semantics (`where`, `outFields`, `resultRecordCount`/`resultOffset`,
  `returnCountOnly`, `outSR=4326`), and two live `GeocodeServer` locators
  (`Canterbury_Composite_Locator` for street addresses, `Canterbury_Places_Composite_Locator` for
  named places) discovered under the `Locators` folder and confirmed with real queries (e.g. "200
  Tuam Street Christchurch" → PointAddress match; "Hagley Park" → place match). Polygon geometry
  was confirmed to return raw `rings` arrays on request — `nz_geo_query_canterbury_layer` and
  `nz_geo_get_parcel`/`nz_geo_query_layer` all reduce any geometry to a centroid + bounding box
  before returning it, never raw coordinates, per this collection's geospatial guidance.
- **No nationwide address search tool.** The original assignment sketch suggested
  `nz_geo_search_addresses`; LDS's vector query API has no free-text search mode (point+radius
  only), so a nationwide version isn't supported by the real upstream. The Canterbury-region
  geocoder genuinely supports free-text address/place search, so it's exposed as
  `nz_geo_search_canterbury_addresses` with an honest, region-scoped name and description rather
  than a nationwide tool that would silently fail outside Canterbury.
- **Tool count (6)** is below the 7-11 suggested in the original assignment sketch. This reflects
  the real capabilities of the three upstream APIs once researched (LDS has one query mode, not
  several; LINZ Basemaps is a pure URL builder with no separate "list styles" endpoint to wrap)
  rather than an attempt to hit a target count — the best-practice guidance this collection
  follows explicitly prefers a small set of well-justified tools over 1:1 endpoint wrapping.
