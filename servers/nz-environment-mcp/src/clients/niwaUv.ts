import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://api.niwa.co.nz/uv";
const SOURCE = "NIWA UV API";
const USER_AGENT = "nz-mcp-collection/nz-environment-mcp (+https://mcp.iolab.nz)";

/**
 * Fetch the raw UV forecast JSON for a location.
 *
 * NOTE ON FIELD NAMES: NIWA's `/uv/data` route requires an API key, and its interactive
 * docs at developer.niwa.co.nz are a client-rendered SPA that resists automated fetching
 * (confirmed: the server returns only an empty `<app>` shell to non-browser clients, and
 * no third-party open-source client for this specific endpoint could be found, unlike the
 * Tide API which two independent GitHub projects document). The catalog's sample request
 * (`lat`, `long`, `apikey`) is confirmed; the exact JSON response shape is not. This
 * returns the parsed JSON untouched — see getUvForecast.ts for the defensive shape-sniffing
 * applied on top of it, and README.md for how to confirm/fix this once a real key exists.
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
