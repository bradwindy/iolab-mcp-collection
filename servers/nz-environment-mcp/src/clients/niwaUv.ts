import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://api.niwa.co.nz/uv";
const SOURCE = "NIWA UV API";
const USER_AGENT = "nz-mcp-collection/nz-environment-mcp (+https://github.com/bradwindy/nz-mcp-collection)";

/**
 * Fetch the raw UV forecast JSON for a location.
 *
 * Confirmed live 2026-07-10 against a real key: `{ products: [{ name, values: [{time, value}] }], coord }`,
 * with two products (`cloudy_sky_uv_index`, `clear_sky_uv_index`), each a ~73-hour series. This
 * returns the parsed JSON untouched — see getUvForecast.ts for how it's flattened into `forecast[]`.
 */
export async function getUvData(params: { apiKey: string; lat: number; long: number }): Promise<unknown> {
  const url = new URL(`${BASE_URL}/data`);
  url.searchParams.set("lat", String(params.lat));
  url.searchParams.set("long", String(params.long));

  const response = await fetchWithBackoff(url, {
    headers: { "x-apikey": params.apiKey, "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return await response.json();
}
