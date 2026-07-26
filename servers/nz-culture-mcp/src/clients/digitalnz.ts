import { fetchWithBackoff, UpstreamHttpError } from "@iolab/mcp-kit";

const BASE_URL = "https://api.digitalnz.org/v3";
const SOURCE = "DigitalNZ";
const USER_AGENT = "nz-mcp-collection/nz-culture-mcp (+https://github.com/bradwindy/nz-mcp-collection)";

/**
 * Field superset requested for search hits: enough to build both the concise and detailed
 * tool responses without pulling DigitalNZ's much larger full-record payload (empty holding/
 * identifier/eprints arrays present on almost every record type) across the wire per hit.
 * Confirmed live against https://api.digitalnz.org/v3/records.json — the `fields` param slims
 * the response to exactly this list.
 */
const SEARCH_FIELDS = [
  "id",
  "title",
  "display_collection",
  "display_content_partner",
  "category",
  "dnz_type",
  "display_date",
  "date",
  "rights",
  "thumbnail_url",
  "large_thumbnail_url",
  "landing_url",
  "description",
  "creator",
  "subject",
  "tag",
  "usage",
  "copyright",
  "language",
  "is_commercial_use",
  "source_url",
].join(",");

export type DigitalNzRecord = {
  id: number;
  title?: string | null;
  description?: string | null;
  display_collection?: string | null;
  display_content_partner?: string | null;
  category?: string[];
  dnz_type?: string | null;
  display_date?: string | null;
  date?: string[];
  rights?: string | null;
  copyright?: string[];
  usage?: string[];
  language?: string[];
  creator?: string[];
  subject?: string[];
  tag?: string[];
  thumbnail_url?: string | null;
  large_thumbnail_url?: string | null;
  landing_url?: string | null;
  source_url?: string | null;
  is_commercial_use?: boolean | null;
};

export type DigitalNzFacets = Record<string, Record<string, number>>;

export type SearchDigitalNzParams = {
  text?: string;
  category?: string;
  geoBbox?: string;
  sort?: "date" | "syndication_date";
  direction?: "asc" | "desc";
  perPage: number;
  page: number;
  includeFacets: boolean;
};

export type SearchDigitalNzResult = {
  records: DigitalNzRecord[];
  totalCount: number;
  facets?: DigitalNzFacets;
};

/**
 * Search DigitalNZ's aggregated metadata index (30M+ records from NZ libraries, museums,
 * archives, and universities). No API key required for public reads. DigitalNZ paginates by
 * page number rather than an arbitrary skip/offset, so callers must convert `offset` to a page
 * (the tool layer enforces `offset` is a multiple of `limit` so this conversion is exact).
 */
export async function searchDigitalNz(params: SearchDigitalNzParams): Promise<SearchDigitalNzResult> {
  const url = new URL(`${BASE_URL}/records.json`);
  if (params.text) url.searchParams.set("text", params.text);
  if (params.category) url.searchParams.set("and[category][]", params.category);
  if (params.geoBbox) url.searchParams.set("geo_bbox", params.geoBbox);
  if (params.sort) {
    url.searchParams.set("sort", params.sort);
    url.searchParams.set("direction", params.direction ?? "desc");
  }
  url.searchParams.set("per_page", String(params.perPage));
  url.searchParams.set("page", String(params.page));
  url.searchParams.set("fields", SEARCH_FIELDS);
  if (params.includeFacets) {
    url.searchParams.set("facets", "category,display_collection,display_content_partner");
    url.searchParams.set("facets_per_page", "8");
  }

  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const body = (await response.json()) as {
    search: { result_count: number; results: DigitalNzRecord[]; facets?: DigitalNzFacets };
  };

  return {
    records: body.search.results,
    totalCount: body.search.result_count,
    ...(params.includeFacets && body.search.facets ? { facets: body.search.facets } : {}),
  };
}

/** Fetch one DigitalNZ record's full default field set by numeric id. */
export async function getDigitalNzRecord(recordId: number): Promise<DigitalNzRecord> {
  const url = new URL(`${BASE_URL}/records/${recordId}.json`);
  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const body = (await response.json()) as { record: DigitalNzRecord };
  return body.record;
}
