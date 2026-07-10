import { z } from "zod";
import {
  attribution,
  describePage,
  jsonResult,
  limitParam,
  missingCredentialError,
  offsetParam,
  responseFormatParam,
  selectFormat,
  toolError,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { getCredential } from "@nz-mcp/credentials";
import { NZXPLORER_API_KEY, PORTAL_URL, SERVER_SLUG } from "../constants.js";
import { searchAnnouncements as searchAnnouncementsClient } from "../clients/nzxplorer.js";

/** Confirmed against the `type` query parameter description in NZXplorer's published OpenAPI spec. */
const ANNOUNCEMENT_TYPES = ["SHINTR", "GENERAL", "MKTUPDTE", "MEETING", "SECISSUE", "FLLYR", "HALFYR", "DVDEND"] as const;

export const searchMarketAnnouncementsInputShape = {
  query: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Full-text search across announcement titles AND extracted PDF document content."),
  ticker: z.string().min(1).max(10).optional().describe("Filter to one NZX ticker, e.g. 'FPH'."),
  announcement_type: z
    .enum(ANNOUNCEMENT_TYPES)
    .optional()
    .describe(
      "Filter by announcement type: SHINTR (shareholder/insider trade), GENERAL, MKTUPDTE (market update), " +
        "MEETING, SECISSUE (security issue), FLLYR (full-year result), HALFYR (half-year result), DVDEND (dividend).",
    ),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Start date, inclusive, as YYYY-MM-DD."),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("End date, inclusive, as YYYY-MM-DD."),
  limit: limitParam(100, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchMarketAnnouncementsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchMarketAnnouncementsInputShape);

/**
 * NZXplorer's OpenAPI spec has no dedicated Announcement schema (the /announcements response is a
 * generic, untyped Envelope), so exact field names for an announcement item are unconfirmed
 * without a live key. This defensively tries a few plausible field-name variants; detailed format
 * always includes the complete raw record regardless, so nothing is lost if these guesses miss.
 */
function toConcise(item: Record<string, unknown>) {
  return {
    id: item.id ?? item.announcement_id ?? null,
    ticker: item.ticker ?? item.company_ticker ?? null,
    title: item.title ?? item.headline ?? null,
    type: item.type ?? item.announcement_type ?? null,
    date: item.date ?? item.published_date ?? item.announcement_date ?? null,
    url: item.url ?? item.pdf_url ?? item.link ?? null,
  };
}

function toDetailed(item: Record<string, unknown>) {
  return { ...toConcise(item), raw: item };
}

/** `env` supplies the D1-backed credential lookup — NZXplorer requires an API key. */
export async function searchMarketAnnouncementsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const apiKey = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, NZXPLORER_API_KEY, env.ENCRYPTION_KEY);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, NZXPLORER_API_KEY, PORTAL_URL);

  if (!input.query && !input.ticker) {
    return toolError(
      "Provide at least a `query` (full-text keyword) or `ticker`.",
      "Searching with neither would return an unfiltered slice of NZXplorer's 64,000+ announcements. " +
        "Optionally narrow further with `announcement_type` or a date range.",
    );
  }

  try {
    const { items, totalCount } = await searchAnnouncementsClient(apiKey, {
      ...(input.query ? { search: input.query } : {}),
      ...(input.ticker ? { ticker: input.ticker.toUpperCase() } : {}),
      ...(input.announcement_type ? { type: input.announcement_type } : {}),
      ...(input.from_date ? { from: input.from_date } : {}),
      ...(input.to_date ? { to: input.to_date } : {}),
      limit: input.limit,
      offset: input.offset,
    });

    const page = describePage({ returned: items.length, total_count: totalCount, offset: input.offset });
    const formatted = items.map((item) => selectFormat(input.response_format, toConcise(item), toDetailed(item)));

    return jsonResult({
      items: formatted,
      ...page,
      notice: truncationNotice(
        input.offset + items.length,
        totalCount,
        "Narrow with `ticker`, `announcement_type`, or a date range, or page with `offset`.",
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
