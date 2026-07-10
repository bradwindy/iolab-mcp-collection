# nz-govt-mcp

MCP server for NZ civic and open-data research. Wraps four upstream sources, **all fully public — no
API key required for any tool on this server.**

1. **[Charities Services Open Data](https://www.charities.govt.nz/charities-in-new-zealand/the-charities-register/open-data)** —
   the Charities Register via its legacy OData v1/v2 endpoint.
2. **[data.govt.nz APIs](https://catalogue.data.govt.nz/)** — the CKAN-based national open-data
   catalogue (dataset search/metadata, plus datastore SQL for datastore-enabled resources).
3. **[Auckland Council Open Data](https://data-aucklandcouncil.opendata.arcgis.com/)** — Auckland
   Council's ArcGIS Hub open-data catalogue search.
4. **[Education Counts](https://www.educationcounts.govt.nz/directories/school-directory-api)** —
   the Ministry of Education's School and Early Childhood Services directories, both served as
   datastore-backed resources within the data.govt.nz catalogue.

This is the collection's reference implementation — every other server mirrors its structure. See
[`docs/ADDING_A_SERVER.md`](../../docs/ADDING_A_SERVER.md).

## Tools

| Tool | Description | Upstream |
|---|---|---|
| `nz_govt_search_charities` | Search the Charities Register by name or exact registration number, optionally filtered by status. | Charities Services |
| `nz_govt_search_datasets` | Search the data.govt.nz open-data catalogue by keyword. | data.govt.nz |
| `nz_govt_get_dataset` | Fetch full metadata and the resource list for one dataset by id or slug. | data.govt.nz |
| `nz_govt_search_auckland_open_data` | Search Auckland Council's open-data catalogue (GIS layers, tables, services) by keyword. | Auckland Council |
| `nz_govt_search_schools` | Search the NZ school directory by name and/or region. | Education Counts |
| `nz_govt_search_early_childhood_services` | Search the NZ early childhood (ECE) services directory by name and/or region. | Education Counts |
| `nz_govt_query_open_data_sql` | Advanced escape hatch: read-only SQL SELECT against a datastore-enabled data.govt.nz resource (find resource ids via `nz_govt_get_dataset`). Restricted to a single SELECT statement — no semicolon-chaining. | data.govt.nz |

Every tool follows the collection's conventions: `response_format: "concise" | "detailed"` (default
concise), `limit`/`offset` pagination with `total_count`/`has_more`/`next_offset`, a `notice` field on
truncated results, and a `source`/`url` `attribution` object.

## Upstream API keys

None. Every tool works immediately after deploy.

## Example research questions

- "Is 'The Salvation Army New Zealand' currently a registered charity, and when was it registered?"
  (`nz_govt_search_charities`)
- "What open datasets does data.govt.nz have about school mergers and closures?"
  (`nz_govt_search_datasets` → `nz_govt_get_dataset`)
- "Which schools in the Wellington region are co-educational secondary schools?"
  (`nz_govt_search_schools`)
- "What Auckland Council open-data layers exist for the Unitary Plan?"
  (`nz_govt_search_auckland_open_data`)

## Research notes

- The Charities Register's OData service is v1/v2 (not the modern OData spec) — filters use the legacy
  `substringof(needle, field)` function, not `contains()`, and accurate `total_count` requires
  `$inlinecount=allpages` rather than assuming the response shape includes a count by default.
- The Education Counts School and ECE directories aren't separate APIs in practice — both are
  datastore-backed resources within one data.govt.nz CKAN package ("Directory of Educational
  Institutions"), resolved to their exact resource ids by inspecting `package_show` output rather than
  guessing from the directory pages alone.
- Auckland Council's open-data search API embeds a full bounding-box polygon (`geometry` and
  `properties.extent`) on every catalog item — this server strips both and returns only summary metadata
  (title, type, snippet, tags, service URL, license), per the collection's rule against returning raw
  geometry by default.
