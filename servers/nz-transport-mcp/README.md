# nz-transport-mcp

MCP server for NZ transport research: Auckland Transport's live GTFS feeds and static network data,
Waka Kotahi NZTA's national highway incident/camera feed, state highway traffic counts, the vehicle
fleet register, and driver licence holder statistics.

Part of the [nz-mcp-collection](../../README.md) — a clustered set of MCP servers over NZ public-data
APIs, deployed as Cloudflare Workers. Every tool is read-only, paginated, and cites its source.

## Tools

| Tool | Upstream | Key required | Description |
|---|---|---|---|
| `nz_transport_get_realtime_alerts` | Auckland Transport | Yes | Current GTFS-realtime service alerts (disruptions, detours, cancellations), optionally filtered by route. |
| `nz_transport_get_vehicle_positions` | Auckland Transport | Yes | Live vehicle positions (location, bearing, speed), optionally filtered by route. |
| `nz_transport_get_trip_updates` | Auckland Transport | Yes | Live predicted arrival/departure delays per stop for in-progress trips, optionally filtered by route. |
| `nz_transport_search_gtfs_stops` | Auckland Transport | Yes | Search the static GTFS stop directory by name. |
| `nz_transport_search_gtfs_routes` | Auckland Transport | Yes | Search the static GTFS route directory by short or long name. |
| `nz_transport_search_highway_incidents` | Waka Kotahi NZTA | No | Search current state highway incidents (crashes, roadworks, closures, hazards), optionally by region. |
| `nz_transport_get_highway_cameras` | Waka Kotahi NZTA | No | National state highway traffic camera directory (location, status, still-image URL), optionally by region. |
| `nz_transport_get_traffic_counts` | Waka Kotahi NZTA | No | Daily state highway traffic volumes from telemetry count sites, filterable by site, region, and date range. |
| `nz_transport_search_vehicle_fleet` | Waka Kotahi NZTA | No | Search the monthly Motor Vehicle Register snapshot by make, fuel type, or owner's territorial authority. |
| `nz_transport_get_licence_holder_stats` | Waka Kotahi NZTA | No | Aggregate driver licence holder statistics by region, licence class, stage, age group, and financial year. |

All tools accept `limit`/`offset` pagination and a `response_format` of `"concise"` (default) or
`"detailed"`. List responses include `total_count`, `has_more`, `next_offset`, a truncation `notice`
when a result set is narrowed, and an `attribution` object naming the upstream source.

## Upstream API keys

**Nine of the ten tools need no key at all** — the four NZTA (Waka Kotahi) sources are fully public,
unauthenticated APIs. Only the five Auckland Transport tools require a subscription key.

### Auckland Transport subscription key (`AT_SUBSCRIPTION_KEY`)

1. Sign up at the [Auckland Transport developer portal](https://dev-portal.at.govt.nz/).
2. Subscribe to the relevant product(s) — the Realtime API and the GTFS API — from your account page.
3. Copy the issued subscription key.
4. Set it for this server through the shared credentials portal (see the monorepo root README), which
   stores it encrypted in the shared `nz-mcp-credentials` D1 database under
   `server = "nz-transport-mcp"`, `key_name = "AT_SUBSCRIPTION_KEY"`.

The key is sent as an `Ocp-Apim-Subscription-Key` header on every Auckland Transport request. AT's
published limits are 600 calls/minute and 35,000 calls/week; this server backs off client-side on
`429`/`5xx` responses (respecting `Retry-After`) and caches the largely-static GTFS stop/route lists
for 24 hours to stay well under quota.

Reference docs: [developer portal](https://dev-portal.at.govt.nz/) ·
[Realtime API](https://dev-portal.at.govt.nz/realtime-api) ·
[GTFS API](https://dev-portal.at.govt.nz/GTFS-API).

## Example research questions

- "Is there a service alert affecting route 70 right now, and where are its buses currently sitting on
  the network?" — `nz_transport_get_realtime_alerts` + `nz_transport_get_vehicle_positions`.
- "How has daily traffic volume through the Gisborne region's telemetry sites changed over the last
  five years?" — `nz_transport_get_traffic_counts` with `region` and a `start_date`/`end_date` range.
- "How many electric vehicles are registered to owners in Auckland, and how does that compare with the
  rest of the country's registered fleet?" — `nz_transport_search_vehicle_fleet` with `fuel_type` and
  `territorial_authority`.
- "Are there any state highway closures in Otago right now, and is there a camera near the affected
  road?" — `nz_transport_search_highway_incidents` + `nz_transport_get_highway_cameras`, both with
  `region: "Otago"`.

## Data notes and caveats

- **Motor Vehicle Register** is a monthly point-in-time snapshot, not a live registry. VINs are
  truncated to 11 characters and owner detail is limited to territorial authority — both are upstream
  privacy protections, not something this server can widen.
- **NZTA Traffic and Travel API** publishes a [WADL](https://trafficnz.info/service/traffic/rest/4?_wadl)
  whose per-parameter documentation is unreliable: `byregion/{region}` is documented as taking a
  "region name" but only the numeric NZTA region id actually resolves live (`.../otago/-1` and
  `.../Otago/-1` both silently return no results; `.../13/-1` works). This server resolves a region name
  or id you supply to the correct numeric id itself.
- **TMS traffic count** `flowDirection` values are undocumented numeric codes; NZTA does not publish
  what each value means beyond "a lane/direction indicator", so this server passes the raw code through
  in `detailed` format rather than guessing a label.
- **GTFS route field names** (`nz_transport_search_gtfs_routes`) are inferred by analogy with the
  confirmed static-GTFS stop shape and canonical `routes.txt` column names, since exercising
  `/gtfs/v3/routes` requires a subscription key this project cannot obtain. All fields are optional and
  passed through defensively; if AT's actual shape differs, unknown fields will simply be `null`
  instead of causing an error.
- The catalog's documented ArcGIS service names for the vehicle register (`MVR_May21`) and licence
  holders dataset (`Driver_licence_holders_dataset`) are stale — NZTA has since renamed them to
  `MVR_Mar26` and `Driver_Licence_Holders` respectively (confirmed by listing the live ArcGIS services
  directory). This server points at the current names.

## Development

```
pnpm install   # from the monorepo root
pnpm --filter @iolab/nz-transport-mcp typecheck
pnpm --filter @iolab/nz-transport-mcp test
pnpm --filter @iolab/nz-transport-mcp dev
```

See `.dev.vars.example` for the local secrets `wrangler dev` expects.
