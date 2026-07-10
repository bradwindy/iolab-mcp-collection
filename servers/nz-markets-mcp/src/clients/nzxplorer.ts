import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://nzxplorer.co.nz/api/v1";
const SOURCE = "NZXplorer API";
const USER_AGENT = "nz-mcp-collection/nz-markets-mcp (+https://mcp.example.invalid)";

/**
 * Free tier is 10 requests/minute (confirmed live: unauthenticated calls return
 * {"error":"Automated access requires an API key..."} with HTTP 403; the published OpenAPI spec at
 * https://nzxplorer.co.nz/openapi.json documents the 429 RateLimited response with a
 * `retry_after_seconds` field and a `Retry-After` header). Keep retries minimal so a single tool
 * call can't burn through most of the per-minute budget on its own.
 */
const RETRY_OPTIONS = { maxAttempts: 2, baseDelayMs: 1500, maxDelayMs: 20_000 };

/** Confirmed against components.schemas.CompanySummary in the live OpenAPI spec. */
export type CompanySummary = {
  id: number;
  ticker: string;
  name: string;
  sector: string;
  slug: string;
  market_cap: number | null;
  website_url: string | null;
  isin: string | null;
  lei: string | null;
  exchange_mic: string | null;
} & Record<string, unknown>;

type Envelope<T> = { data: T; meta: Record<string, unknown> };

async function callApi<T>(
  apiKey: string,
  path: string,
  searchParams: Record<string, string | number | undefined>,
): Promise<Envelope<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetchWithBackoff(
    url,
    { headers: { "X-API-Key": apiKey, "User-Agent": USER_AGENT, Accept: "application/json" } },
    RETRY_OPTIONS,
  );
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  return (await response.json()) as Envelope<T>;
}

/**
 * NZX's whole listed universe is 131 companies (confirmed in the OpenAPI spec description), well
 * under the API's own max page size of 500 (GET /companies `limit` param, max 500 per spec). We
 * deliberately fetch the whole roster in one call — no `search`/`sector` params passed upstream —
 * so the tool layer can cache it once and filter+paginate both `query` and `sector` client-side
 * from the same snapshot, rather than fragmenting the KV cache per distinct query string and
 * burning the 10 req/min free-tier budget on repeat searches.
 */
export async function listAllCompanies(apiKey: string): Promise<CompanySummary[]> {
  const { data } = await callApi<CompanySummary[]>(apiKey, "/companies", {
    limit: 500,
    sort: "ticker",
    order: "asc",
  });
  return data;
}

/**
 * GET /companies/{ticker}?include=... — `include` accepts a comma-separated list of
 * directors/financials/governance/price/all (confirmed in the OpenAPI spec). We always request
 * `all` and let the tool layer decide how much of the result to surface for concise vs detailed,
 * since the nested sub-object field names for directors/financials/governance/price aren't pinned
 * down in the spec (the response schema for this operation is just a generic, untyped Envelope).
 */
export async function getCompany(apiKey: string, ticker: string): Promise<Record<string, unknown>> {
  const { data } = await callApi<Record<string, unknown>>(apiKey, `/companies/${encodeURIComponent(ticker)}`, {
    include: "all",
  });
  return data;
}

export type AnnouncementSearchParams = {
  search?: string;
  ticker?: string;
  type?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
};

export type AnnouncementSearchResult = {
  items: Array<Record<string, unknown>>;
  totalCount: number;
};

/**
 * GET /announcements supports true offset pagination (limit/offset), unlike /companies-derived
 * endpoints — meta.total on PaginatedEnvelope gives the real total, so we can page it the normal
 * server-side way instead of fetching everything. The exact per-item field names aren't pinned
 * down by the spec (no dedicated Announcement schema — data is untyped), so items are passed
 * through as loosely-typed records; the tool layer applies a defensive multi-key-name guess for
 * the concise view and always includes the full raw record in detailed view.
 */
export async function searchAnnouncements(
  apiKey: string,
  params: AnnouncementSearchParams,
): Promise<AnnouncementSearchResult> {
  const { data, meta } = await callApi<Array<Record<string, unknown>>>(apiKey, "/announcements", {
    ...(params.search ? { search: params.search } : {}),
    ...(params.ticker ? { ticker: params.ticker } : {}),
    ...(params.type ? { type: params.type } : {}),
    ...(params.from ? { from: params.from } : {}),
    ...(params.to ? { to: params.to } : {}),
    limit: params.limit,
    offset: params.offset,
  });

  const total = typeof meta.total === "number" ? meta.total : data.length;
  return { items: data, totalCount: total };
}

export { SOURCE as NZXPLORER_SOURCE };
