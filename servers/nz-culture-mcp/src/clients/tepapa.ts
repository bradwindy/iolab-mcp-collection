import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://data.tepapa.govt.nz/collection";
const SOURCE = "Te Papa Collections API";
const USER_AGENT = "nz-mcp-collection/nz-culture-mcp (+https://github.com/bradwindy/nz-mcp-collection)";

/**
 * Field superset requested for concise search hits. Confirmed live (via a short-lived guest
 * token obtained from an unauthenticated request, per the API's documented guest-access flow)
 * that `fields` slims the response the same way across every entity type, including nested
 * arrays like `hasRepresentation` (the object model's embedded image list).
 */
const SEARCH_FIELDS = [
  "id",
  "type",
  "title",
  "prefLabel",
  "scientificName",
  "vernacularName",
  "collection",
  "collectionLabel",
  "identifier",
  "hasRepresentation",
  "iri",
  "href",
  "rightsHolder",
  "accessRights",
].join(",");

/**
 * Te Papa's object model has no single shared schema — a Taxon, a Specimen, and a Place carry
 * entirely different fields. `z.record` in the tool layer intentionally leaves this loose;
 * this type only pins down the handful of fields present on (almost) everything.
 */
export type TePapaRecord = Record<string, unknown> & {
  id: number;
  type: string;
  title?: string;
};

export type TePapaSearchResult = {
  results: TePapaRecord[];
  totalCount: number;
};

/**
 * Entity-type filter values for `nz_culture_search_te_papa`'s `collection` param, confirmed live
 * via a `facets: [{ field: "type", size: 20 }]` aggregation against the whole collection. `Agent`
 * is a convenience alias (matching the API's own `/agent` fetch-by-id path) that ORs the two
 * underlying types, since Te Papa has no single `Agent` type value.
 */
export type TePapaCollectionFilter =
  | "Object"
  | "Specimen"
  | "Agent"
  | "Taxon"
  | "Place"
  | "Topic"
  | "Category"
  | "Publication";

function typeFilter(filter: TePapaCollectionFilter): string {
  return filter === "Agent" ? "(type:Person OR type:Organisation)" : `type:${filter}`;
}

export async function searchTePapa(params: {
  apiKey: string;
  query: string;
  collection?: TePapaCollectionFilter;
  from: number;
  size: number;
  detailed: boolean;
}): Promise<TePapaSearchResult> {
  const q = params.collection ? `${params.query} AND ${typeFilter(params.collection)}` : params.query;

  const url = new URL(`${BASE_URL}/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("from", String(params.from));
  url.searchParams.set("size", String(params.size));
  if (!params.detailed) url.searchParams.set("fields", SEARCH_FIELDS);

  const response = await fetchWithBackoff(url, {
    headers: { "x-api-key": params.apiKey, Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const body = (await response.json()) as {
    results?: TePapaRecord[];
    _metadata: { resultset: { count: number; from: number; size: number } };
  };

  // Confirmed live: a zero-hit search omits `results` entirely rather than returning `[]`.
  return { results: body.results ?? [], totalCount: body._metadata.resultset.count };
}

/**
 * The API's fetch-by-id paths, confirmed live (GET /collection/{path}/{id}) against real ids.
 * Critically, ids are only unique WITHIN a resource path, not globally — e.g. id 7320 is a
 * Little Spotted Kiwi Taxon under /taxon/7320 but an unrelated moss Specimen under /object/7320.
 * `media`, `group`, and `fieldcollection` cover embedded sub-records (an object's images, a
 * taxonomic/agent grouping, a collecting event) that are reachable by id but rarely appear as
 * top-level search hits.
 */
export const TE_PAPA_ITEM_PATHS = [
  "object",
  "agent",
  "place",
  "taxon",
  "document",
  "topic",
  "group",
  "fieldcollection",
  "media",
  "category",
] as const;

export type TePapaItemPath = (typeof TE_PAPA_ITEM_PATHS)[number];

export async function getTePapaItem(params: {
  apiKey: string;
  resourcePath: TePapaItemPath;
  id: number;
}): Promise<TePapaRecord> {
  const url = new URL(`${BASE_URL}/${params.resourcePath}/${params.id}`);
  const response = await fetchWithBackoff(url, {
    headers: { "x-api-key": params.apiKey, Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  return (await response.json()) as TePapaRecord;
}
