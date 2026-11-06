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
} from "@iolab/mcp-kit";
import { getCredential } from "@iolab/credentials";
import { NZXPLORER_API_KEY, SERVER_SLUG } from "../constants.js";
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
 * NZXplorer's OpenAPI spec has no Announcement schema (the /announcements response is an untyped
 * Envelope), and the first guesses here missed: a smoke test found `ticker` and `url` null in the
 * concise view while the raw record had them. So each field now tries a wider set of names, then
 * looks one level into nested objects (e.g. `company.ticker`). `logAnnouncementKeys` records the
 * real key names (never values) so this can be pinned down from Workers Logs.
 */
const FIELD_CANDIDATES = {
  id: ["id", "announcement_id", "announcementId", "nzx_id"],
  ticker: ["ticker", "company_ticker", "companyTicker", "symbol", "code", "security_code", "issuer_code", "nzx_code"],
  title: ["title", "headline", "subject", "name"],
  type: ["type", "announcement_type", "announcementType", "category"],
  date: ["date", "published_date", "publishedDate", "announcement_date", "announced_at", "published_at", "created_at", "datetime"],
  url: ["url", "pdf_url", "pdfUrl", "link", "announcement_url", "nzx_url", "source_url", "document_url", "href"],
} as const;

function firstPresent(record: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/** Top-level match first, then one level into nested plain objects (e.g. `company: { ticker }`). */
export function pickField(item: Record<string, unknown>, names: readonly string[]): unknown {
  const direct = firstPresent(item, names);
  if (direct !== undefined) return direct;
  for (const value of Object.values(item)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = firstPresent(value as Record<string, unknown>, names);
      if (nested !== undefined && typeof nested !== "object") return nested;
    }
  }
  // URLs: fall back to the first top-level string that is an http(s) link.
  if (names === FIELD_CANDIDATES.url) {
    const link = Object.values(item).find((value) => typeof value === "string" && /^https?:\/\//i.test(value));
    if (link !== undefined) return link;
  }
  return undefined;
}

export function toConcise(item: Record<string, unknown>) {
  return {
    id: pickField(item, FIELD_CANDIDATES.id) ?? null,
    ticker: pickField(item, FIELD_CANDIDATES.ticker) ?? null,
    title: pickField(item, FIELD_CANDIDATES.title) ?? null,
    type: pickField(item, FIELD_CANDIDATES.type) ?? null,
    date: pickField(item, FIELD_CANDIDATES.date) ?? null,
    url: pickField(item, FIELD_CANDIDATES.url) ?? null,
  };
}

/** Key names only (and nested key names), never values. */
function logAnnouncementKeys(item: Record<string, unknown> | undefined): void {
  if (!item) return;
  const keys = Object.entries(item).map(([key, value]) =>
    value && typeof value === "object" && !Array.isArray(value) ? `${key}{${Object.keys(value).join(",")}}` : key,
  );
  console.log("[nzxplorer] announcement item keys:", keys.join(","));
}

function toDetailed(item: Record<string, unknown>) {
  return { ...toConcise(item), raw: item };
}

/** `env` supplies the D1-backed credential lookup — NZXplorer requires an API key. */
export async function searchMarketAnnouncementsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const apiKey = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, NZXPLORER_API_KEY, env.ENCRYPTION_KEY);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, NZXPLORER_API_KEY, env.PORTAL_URL);

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

    logAnnouncementKeys(items[0]);
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
