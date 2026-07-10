import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

/**
 * IMPORTANT: this is the Azure API Management *gateway* host, not the developer-portal host.
 * The api-catalog entry (and the EA docs page) list `https://emi.developer.azure-api.net` as the
 * base URL, but that host only serves the interactive developer-portal SPA (confirmed live: it
 * returns an HTML shell that 404s on every REST-style path). The actual gateway that accepts
 * `Ocp-Apim-Subscription-Key` requests is `https://emi.azure-api.net` — confirmed live: this host
 * returns `401 {"message":"Access denied due to missing subscription key..."}` with a
 * `WWW-Authenticate: AzureApiManagementKey ... name="Ocp-Apim-Subscription-Key"` header for both
 * `/real-time-dispatch` and `/ICPConnectionData/v2/...`, whereas the same paths 404 on the
 * developer-portal host. Confirmed by reading the portal's own `/config.json` (which points its
 * frontend at the underlying `emi.management.azure-api.net` content API) and then querying that
 * content API's public, unauthenticated `/apis`, `/apis/{id}/operations`, and `/products`
 * sub-resources directly — these mirror the exact operations, urlTemplates, query parameters, and
 * example request/response payloads the interactive docs page renders client-side via JavaScript
 * (which a plain HTTP fetch can't execute).
 */
const GATEWAY_BASE_URL = "https://emi.azure-api.net";
const SOURCE = "Electricity Authority EMI APIs";
const USER_AGENT = "nz-mcp-collection/nz-markets-mcp (+https://github.com/bradwindy/nz-mcp-collection)";
const SUBSCRIPTION_KEY_HEADER = "Ocp-Apim-Subscription-Key";

async function gatewayFetch(url: URL, apiKey: string): Promise<Response> {
  return fetchWithBackoff(url, {
    headers: {
      [SUBSCRIPTION_KEY_HEADER]: apiKey,
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
}

// ---------------------------------------------------------------------------
// Real-time dispatch API. Product: "Wholesale market prices". Policy (from the product's own
// description, read via the content API): 60 calls/minute and 60 MB/hour.
// Path confirmed live: GET https://emi.azure-api.net/real-time-dispatch/ (urlTemplate "/", no
// version segment — this API has no apiVersionSet, unlike ICP connection data below).
// ---------------------------------------------------------------------------

/** One row per point of connection for the latest 5-minute dispatch interval. Field names and
 * casing confirmed against the operation's documented example response (content API). */
export type DispatchRecord = {
  PointOfConnectionCode: string;
  /** NZ local time. */
  FiveMinuteIntervalDatetime: string;
  FiveMinuteIntervalNumber: number;
  /** UTC, no timezone marker. */
  RunDateTime: string;
  SPDLoadMegawatt: number;
  SPDGenerationMegawatt: number;
  DollarsPerMegawattHour: number;
};

function odataStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The operation supports a single OData `$filter` query param over PointOfConnectionCode (eq),
 * FiveMinuteIntervalDatetime (eq), FiveMinuteIntervalNumber (eq/le/ge), and DollarsPerMegawattHour
 * (eq/le/ge) — documented examples confirmed live via the content API. We only expose the two
 * most useful ones (point of connection, and a specific interval) at the tool layer.
 */
export async function getRealTimeDispatch(params: {
  apiKey: string;
  pointOfConnectionCode?: string;
  /** `YYYY-MM-DDTHH:MM`, matching the documented `datetime'2020-04-01T00:00'` filter literal. */
  atDatetime?: string;
}): Promise<DispatchRecord[]> {
  const filters: string[] = [];
  if (params.pointOfConnectionCode) {
    filters.push(`PointOfConnectionCode eq ${odataStringLiteral(params.pointOfConnectionCode)}`);
  }
  if (params.atDatetime) {
    filters.push(`FiveMinuteIntervalDatetime eq datetime'${params.atDatetime}'`);
  }

  const url = new URL(`${GATEWAY_BASE_URL}/real-time-dispatch/`);
  if (filters.length > 0) url.searchParams.set("$filter", filters.join(" and "));

  const response = await gatewayFetch(url, params.apiKey);
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return (await response.json()) as DispatchRecord[];
}

// ---------------------------------------------------------------------------
// ICP connection data v2 API. Product: "ICP connection data". Policy (from the product's own
// description): 50 calls/minute for search, 75 calls/minute for get-by-id, and/or 10 MB/hour.
// This API uses Segment-style version routing (confirmed via its apiVersionSet's
// `versioningScheme: "Segment"`), so the gateway path needs a `/v2/` segment — NOT documented
// anywhere in the interactive docs' visible text, only discoverable by testing:
// `/ICPConnectionData/search/...` 404s, `/ICPConnectionData/v2/search/...` reaches the operation
// (401 missing-key rather than 404 not-found).
// ---------------------------------------------------------------------------

export type IcpAddress = {
  PropertyNameOrDescription: string | null;
  PhysicalAddressUnit: string | null;
  PhysicalAddressNumber: string | null;
  PhysicalAddressStreet: string | null;
  PhysicalAddressSuburb: string | null;
  PhysicalAddressTown: string | null;
  PhysicalAddressRegion: string | null;
  PhysicalAddressPostCode: number | null;
  GPS_Easting: number | null;
  GPS_Northing: number | null;
};

/** Returned by the "get by id" operation. `ICPStatus` is a numeric code; the EA docs don't
 * publish a lookup table for it, so it's surfaced as-is rather than guessed at. */
export type IcpDetails = {
  ICPIdentifier: string;
  ICPStatus: number;
  Address: IcpAddress | null;
  Network: Record<string, unknown> | null;
  Pricing: Record<string, unknown> | null;
  Trader: Record<string, unknown> | null;
  Metering: Record<string, unknown> | null;
  Messages: unknown[];
};

/** Returned by the "search" operation. Documented example shows a single object rather than an
 * array, but the operation description explicitly says a wildcard address search "will likely get
 * multiple addresses returned" — so callers must treat the response as either shape defensively
 * (see normalizeToArray below). Only carries Address/ICPIdentifier/ICPStatus/Messages — the
 * richer Network/Pricing/Trader/Metering blocks are only available via getIcpById. */
export type IcpSearchHit = {
  Address: IcpAddress;
  ICPIdentifier: string;
  ICPStatus: number;
  Messages?: unknown[];
};

/** A valid ICP: 10 digits, 2 letters, 3 hex characters (15 total) — wording and example
 * ("0000123456ZZAF0") taken verbatim from the operation's own parameter description. */
const ICP_FORMAT = /^\d{10}[A-Za-z]{2}[0-9A-Fa-f]{3}$/;

export function isValidIcpFormat(value: string): boolean {
  return ICP_FORMAT.test(value.trim());
}

function normalizeToArray<T>(body: T | T[]): T[] {
  return Array.isArray(body) ? body : [body];
}

export async function getIcpById(params: { apiKey: string; icp: string }): Promise<IcpDetails[]> {
  const url = new URL(`${GATEWAY_BASE_URL}/ICPConnectionData/v2/single/`);
  url.searchParams.set("ICP", params.icp.trim().toUpperCase());

  const response = await gatewayFetch(url, params.apiKey);
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return normalizeToArray((await response.json()) as IcpDetails | IcpDetails[]);
}

export async function searchIcpByAddress(params: {
  apiKey: string;
  streetNumber: string;
  streetName: string;
  suburbOrTown?: string;
  region?: string;
}): Promise<IcpSearchHit[]> {
  const url = new URL(`${GATEWAY_BASE_URL}/ICPConnectionData/v2/search/`);
  url.searchParams.set("streetNumber", params.streetNumber);
  url.searchParams.set("streetName", params.streetName);
  if (params.suburbOrTown) url.searchParams.set("suburbOrTown", params.suburbOrTown);
  if (params.region) url.searchParams.set("region", params.region);

  const response = await gatewayFetch(url, params.apiKey);
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return normalizeToArray((await response.json()) as IcpSearchHit | IcpSearchHit[]);
}

/**
 * Best-effort split of a free-text address into the upstream's required streetNumber + streetName
 * (both mandatory per the operation's documented 400 response) plus optional suburbOrTown/region.
 * Handles "2 Main Street, Auckland, Auckland" -> {streetNumber: "2", streetName: "Main Street",
 * suburbOrTown: "Auckland", region: "Auckland"}. Does not handle unit/flat prefixes like "2/15
 * Main Street" specially — the whole "2/15" token is taken as the street number, which the
 * upstream wildcard search tolerates poorly; callers should prefer the plain street number in
 * that case.
 */
export function parseAddressQuery(raw: string): {
  streetNumber?: string;
  streetName?: string;
  suburbOrTown?: string;
  region?: string;
} {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const [firstPart, suburbOrTown, region] = parts;
  // Requires the leading token to start with a digit (e.g. "12", "2A", "2/15") so a
  // number-less address like "Queen Street" doesn't get misread as street number "Queen".
  const match = firstPart ? /^(\d\S*)\s+(.+)$/.exec(firstPart) : null;

  return {
    ...(match?.[1] ? { streetNumber: match[1] } : {}),
    ...(match?.[2] ? { streetName: match[2] } : {}),
    ...(suburbOrTown ? { suburbOrTown } : {}),
    ...(region ? { region } : {}),
  };
}

export { SOURCE as ELECTRICITY_AUTHORITY_SOURCE };
