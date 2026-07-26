import { z } from "zod";
import {
  attribution,
  cached,
  CACHE_TTL,
  jsonResult,
  missingCredentialError,
  responseFormatParam,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { getCredential } from "@iolab/credentials";
import { NZXPLORER_API_KEY, SERVER_SLUG } from "../constants.js";
import { getCompany as getCompanyClient } from "../clients/nzxplorer.js";

export const getCompanyInputShape = {
  ticker: z.string().min(1).max(10).describe("NZX ticker symbol, e.g. 'FPH', 'AIR', or 'SPK'. Case-insensitive."),
  response_format: responseFormatParam,
};

export const getCompanyOutputShape = {
  ticker: z.string(),
  name: z.string().nullable(),
  sector: z.string().nullable(),
  market_cap_nzd: z.number().nullable(),
  website_url: z.string().nullable(),
  isin: z.string().nullable(),
  lei: z.string().nullable(),
  exchange_mic: z.string().nullable(),
  slug: z.string().nullable(),
  /** Full upstream payload (directors, financials, governance score, latest price where
   * available) — only populated for response_format: "detailed", since the exact nested field
   * names aren't pinned down by NZXplorer's published schema for this operation. */
  raw: z.record(z.string(), z.unknown()).optional(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getCompanyInputShape);

const KNOWN_FIELDS = ["ticker", "name", "sector", "market_cap", "website_url", "isin", "lei", "exchange_mic", "slug"] as const;

function toConcise(data: Record<string, unknown>, ticker: string) {
  return {
    ticker: (data.ticker as string | undefined) ?? ticker,
    name: (data.name as string | undefined) ?? null,
    sector: (data.sector as string | undefined) ?? null,
    market_cap_nzd: (data.market_cap as number | undefined) ?? null,
    website_url: (data.website_url as string | undefined) ?? null,
    isin: (data.isin as string | undefined) ?? null,
    lei: (data.lei as string | undefined) ?? null,
    exchange_mic: (data.exchange_mic as string | undefined) ?? null,
    slug: (data.slug as string | undefined) ?? null,
  };
}

/**
 * `env` supplies the D1-backed credential lookup (NZXplorer requires an API key) and the KV
 * cache — company profiles change rarely intraday, so one cache entry (keyed on the `include=all`
 * fetch) serves both concise and detailed requests for the same ticker.
 */
export async function getCompanyHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const ticker = input.ticker.trim().toUpperCase();

  const apiKey = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, NZXPLORER_API_KEY, env.ENCRYPTION_KEY);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, NZXPLORER_API_KEY, env.PORTAL_URL);

  try {
    const data = await cached(env.MCP_CACHE, `nz-markets:nzxplorer:company:${ticker}`, CACHE_TTL.SLOW_MOVING, () =>
      getCompanyClient(apiKey, ticker),
    );

    const summary = toConcise(data, ticker);
    const rawExtras =
      input.response_format === "detailed"
        ? { raw: Object.fromEntries(Object.entries(data).filter(([key]) => !(KNOWN_FIELDS as readonly string[]).includes(key))) }
        : {};

    return jsonResult({
      ...summary,
      ...rawExtras,
      attribution: attribution("NZXplorer (independent third-party service; not affiliated with NZX Limited)", {
        url: `https://nzxplorer.co.nz/companies/${ticker.toLowerCase()}`,
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) {
      if (error.response.status === 404) {
        return upstreamError(
          error.source,
          error.response,
          `No NZX-listed company found for ticker '${ticker}'. Use nz_markets_search_companies to find the correct ticker.`,
        );
      }
      return upstreamError(error.source, error.response);
    }
    throw error;
  }
}
