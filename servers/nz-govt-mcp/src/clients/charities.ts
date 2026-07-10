import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://www.odata.charities.govt.nz";
const SOURCE = "Charities Services Open Data";
const USER_AGENT = "nz-mcp-collection/nz-govt-mcp (+https://mcp.example.invalid)";

export type CharityRecord = {
  OrganisationId: number;
  Name: string | null;
  CharityRegistrationNumber: string | null;
  RegistrationStatus: string | null;
  DateRegistered: string | null;
  DeregistrationDate: string | null;
  WebSiteURL: string | null;
  CharityEmailAddress: string | null;
  PostalAddressCity: string | null;
  PostalAddressSuburb: string | null;
  OrganisationalType: string | null;
};

export type SearchCharitiesParams = {
  query?: string;
  registrationNumber?: string;
  status?: "Registered" | "Deregistered" | "Removed";
  top: number;
  skip: number;
};

export type SearchCharitiesResult = {
  records: CharityRecord[];
  totalCount: number;
};

/** OData v1/v2 string literals escape a single quote by doubling it. */
function odataStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Search the Charities Register via its OData v2 endpoint. This service only supports the
 * legacy `substringof(needle, field)` function syntax, not the modern `contains()`.
 */
export async function searchCharities(params: SearchCharitiesParams): Promise<SearchCharitiesResult> {
  const filters: string[] = [];
  if (params.registrationNumber) {
    filters.push(`CharityRegistrationNumber eq ${odataStringLiteral(params.registrationNumber)}`);
  }
  if (params.query) {
    filters.push(`substringof(${odataStringLiteral(params.query)}, Name)`);
  }
  if (params.status) {
    filters.push(`RegistrationStatus eq ${odataStringLiteral(params.status)}`);
  }

  const url = new URL(`${BASE_URL}/Organisations`);
  url.searchParams.set("$format", "json");
  url.searchParams.set("$top", String(params.top));
  url.searchParams.set("$skip", String(params.skip));
  url.searchParams.set("$inlinecount", "allpages");
  if (filters.length > 0) {
    url.searchParams.set("$filter", filters.join(" and "));
  }

  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const body = (await response.json()) as { d: { results: CharityRecord[]; __count: string } };
  return { records: body.d.results, totalCount: Number(body.d.__count) };
}
