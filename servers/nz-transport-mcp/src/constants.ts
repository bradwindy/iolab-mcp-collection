/** Must exactly match this server's wrangler.jsonc "name" — the credentials store keys rows by it. */
export const SERVER_SLUG = "nz-transport-mcp";

/** Row key in the shared credentials table for the Auckland Transport subscription key. */
export const AT_SUBSCRIPTION_KEY_NAME = "AT_SUBSCRIPTION_KEY";


/**
 * Waka Kotahi NZTA's 14 traffic regions, as returned by the (undocumented but live-verified)
 * `GET /regions/all/-1` operation of the Traffic and Travel API:
 * `curl -H 'Accept: application/json' 'https://trafficnz.info/service/traffic/rest/4/regions/all/-1'`.
 * The WADL claims `byregion/{region}` takes a "region name", but empirically only the numeric
 * id resolves (a name like "Otago" or "otago" silently returns an empty response) — this table
 * lets callers pass either a name or an id and we resolve to the id ourselves.
 */
export const NZTA_TRAFFIC_REGIONS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 1, name: "Northland" },
  { id: 2, name: "Auckland" },
  { id: 3, name: "Waikato" },
  { id: 4, name: "Bay Of Plenty" },
  { id: 5, name: "Gisborne" },
  { id: 6, name: "Hawkes Bay" },
  { id: 7, name: "Taranaki" },
  { id: 8, name: "Manawatu-Whanganui" },
  { id: 9, name: "Wellington" },
  { id: 10, name: "Nelson/Marlborough" },
  { id: 11, name: "Canterbury" },
  { id: 12, name: "West Coast" },
  { id: 13, name: "Otago" },
  { id: 14, name: "Southland" },
];

/** Human-readable "id name, id name, ..." list for embedding in tool/parameter descriptions. */
export const NZTA_REGIONS_DESCRIPTION = NZTA_TRAFFIC_REGIONS.map((r) => `${r.id}=${r.name}`).join(", ");

/** Resolve a caller-supplied region (numeric id, numeric string, or name) to a NZTA region id. */
export function resolveNztaRegionId(region: string): number | null {
  const trimmed = region.trim();
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && NZTA_TRAFFIC_REGIONS.some((r) => r.id === asNumber)) {
    return asNumber;
  }
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, "");
  const match = NZTA_TRAFFIC_REGIONS.find((r) => r.name.toLowerCase().replace(/[\s-]+/g, "") === normalized);
  return match?.id ?? null;
}
