import { z } from "zod";
import {
  attribution,
  cached,
  CACHE_TTL,
  jsonResult,
  limitParam,
  missingCredentialError,
  offsetParam,
  paginate,
  responseFormatParam,
  selectFormat,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { getCredential } from "@iolab/credentials";
import { NZXPLORER_API_KEY, SERVER_SLUG } from "../constants.js";
import { listAllCompanies, type CompanySummary } from "../clients/nzxplorer.js";

export const searchCompaniesInputShape = {
  query: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Free-text match against company name or NZX ticker, e.g. 'Fisher & Paykel' or 'FPH'."),
  sector: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("Free-text match against the GICS-style sector NZXplorer assigns, e.g. 'Healthcare' or 'Technology'."),
  limit: limitParam(100, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchCompaniesOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchCompaniesInputShape);

function toConcise(company: CompanySummary) {
  return {
    ticker: company.ticker,
    name: company.name,
    sector: company.sector,
    market_cap_nzd: company.market_cap,
  };
}

function toDetailed(company: CompanySummary) {
  return {
    ...toConcise(company),
    slug: company.slug,
    isin: company.isin,
    lei: company.lei,
    exchange_mic: company.exchange_mic,
    website_url: company.website_url,
  };
}

/**
 * `env` supplies the D1-backed credential lookup (NZXplorer requires an API key) and the KV
 * cache. See listAllCompanies in ../clients/nzxplorer.ts for why the full 131-company roster is
 * fetched and cached once, with `query`/`sector` filtered and paginated client-side from that
 * snapshot rather than passed upstream per-request.
 */
export async function searchCompaniesHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const apiKey = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, NZXPLORER_API_KEY, env.ENCRYPTION_KEY);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, NZXPLORER_API_KEY, env.PORTAL_URL);

  try {
    const allCompanies = await cached(env.MCP_CACHE, "nz-markets:nzxplorer:companies:all", CACHE_TTL.METADATA, () =>
      listAllCompanies(apiKey),
    );

    let filtered = allCompanies;
    if (input.query) {
      const needle = input.query.toLowerCase();
      filtered = filtered.filter(
        (company) => company.name.toLowerCase().includes(needle) || company.ticker.toLowerCase().includes(needle),
      );
    }
    if (input.sector) {
      const needle = input.sector.toLowerCase();
      filtered = filtered.filter((company) => (company.sector ?? "").toLowerCase().includes(needle));
    }

    const page = paginate(filtered, { limit: input.limit, offset: input.offset }, { defaultLimit: 20, maxLimit: 100 });
    const items = page.items.map((company) => selectFormat(input.response_format, toConcise(company), toDetailed(company)));

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow with `query` or `sector`, or page with `offset`.",
      ),
      attribution: attribution("NZXplorer (independent third-party service; not affiliated with NZX Limited)", {
        url: "https://nzxplorer.co.nz/",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
