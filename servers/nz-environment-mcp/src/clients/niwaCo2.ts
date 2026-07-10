import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://api.niwa.co.nz/co2";
const SOURCE = "NIWA CO2 API";
const USER_AGENT = "nz-mcp-collection/nz-environment-mcp (+https://mcp.example.invalid)";

/**
 * Fetch the latest Baring Head CO2 reading as raw text.
 *
 * NOTE ON FORMAT: this route requires an API key, and NIWA's interactive docs are a
 * client-rendered SPA that resists automated fetching (see niwaUv.ts for the same
 * limitation and how it was confirmed). The catalog confirms the route returns "the
 * latest CO2 information as text" but not its exact line format. `parseInfoText` below
 * makes a best effort at structuring it and always preserves the raw text alongside.
 */
export async function getBaringHeadInfoText(apiKey: string): Promise<string> {
  const url = new URL(`${BASE_URL}/info/baringhead.txt`);

  const response = await fetchWithBackoff(url, {
    headers: { "x-apikey": apiKey, "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return await response.text();
}

/**
 * Best-effort parse of `key: value` / `key = value` style lines out of the info text.
 * Returns {} if the text doesn't look like that at all — callers should always also
 * surface the raw text so no information is lost regardless of the actual format.
 */
export function parseInfoText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([^:=]{1,60}?)\s*[:=]\s*(.+)$/.exec(line);
    if (!match) continue;
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (key && value) result[key] = value;
  }
  return result;
}
