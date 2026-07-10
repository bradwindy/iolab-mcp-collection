import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://api.niwa.co.nz/tides";
const SOURCE = "NIWA Tide Forecasting API";
const USER_AGENT = "nz-mcp-collection/nz-environment-mcp (+https://mcp.iolab.nz)";

export type TideValue = { time: string; value: number };
export type TideDataResponse = { values: TideValue[] };

export type TideRequestParams = {
  apiKey: string;
  lat: number;
  long: number;
  numberOfDays?: number;
  startDate?: string;
  datum?: string;
  interval?: number;
};

function buildQuery(params: TideRequestParams): URLSearchParams {
  const query = new URLSearchParams();
  query.set("lat", String(params.lat));
  query.set("long", String(params.long));
  if (params.numberOfDays !== undefined) query.set("numberOfDays", String(params.numberOfDays));
  if (params.startDate) query.set("startDate", params.startDate);
  if (params.datum) query.set("datum", params.datum);
  if (params.interval !== undefined) query.set("interval", String(params.interval));
  return query;
}

/**
 * Fetch tide predictions. Confirmed against NIWA's own PHP example and two independent
 * open-source clients (see README): auth via the `x-apikey` header, response shape
 * `{ values: [{ time, value }] }`. Absent an `interval`, entries are the alternating
 * high/low tide extrema, not an evenly-sampled curve.
 */
export async function getTideData(params: TideRequestParams): Promise<TideDataResponse> {
  const url = new URL(`${BASE_URL}/data`);
  url.search = buildQuery(params).toString();

  const response = await fetchWithBackoff(url, {
    headers: { "x-apikey": params.apiKey, "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return (await response.json()) as TideDataResponse;
}
