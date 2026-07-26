import { z } from "zod";
import {
  attribution,
  jsonResult,
  limitParam,
  offsetParam,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { cdxTimestampToIso, queryCdx } from "../clients/wayback.js";

export const waybackListSiteUrlsInputShape = {
  url: z.string().min(1).describe("A URL prefix or host to discover archived URLs under, e.g. 'example.com/blog/' or 'example.com'."),
  match_type: z
    .enum(["prefix", "domain"])
    .default("prefix")
    .describe("'prefix' matches this URL and anything under it; 'domain' matches the whole host and its subdomains."),
  from: z.string().regex(/^\d{4,14}$/).optional().describe("Only include URLs first/last seen from this date, YYYY[MMDDHHMMSS]."),
  to: z.string().regex(/^\d{4,14}$/).optional().describe("Only include URLs seen up to this date, same format as `from`."),
  exclude_errors: z
    .boolean()
    .default(true)
    .describe(
      "Drop URLs whose first capture in range 4xx/5xx'd — raw domain/prefix queries otherwise return large volumes of dead links.",
    ),
  limit: limitParam(200, 50),
  offset: offsetParam,
};

export const waybackListSiteUrlsOutputShape = {
  items: z.array(z.object({ url: z.string(), first_seen: z.string(), first_status: z.string() })),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(waybackListSiteUrlsInputShape);

export async function waybackListSiteUrlsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    // `collapse=urlkey` (server-side, native CDX): exactly one row per distinct URL, no matter how
    // many times that URL was captured. This is the ONLY way to reliably sample the full breadth
    // of a site's structure from a bounded row budget — confirmed live against trademe.co.nz's
    // 1999-2001 range: without collapse, the raw (urlkey, timestamp)-sorted result is dominated by
    // whichever URL happened to be crawled most often (its homepage, ~130 of the first 150 raw
    // rows there), starving every other URL out of a small fetch window entirely. The tradeoff:
    // CDX always returns the FIRST (earliest, not latest) row within a collapsed group — there is
    // no server-side way to request "last capture per URL" together with collapse (confirmed live:
    // a negative `limit` changes which END of the alphabetical urlkey range is sampled, not which
    // capture within a group is kept) — hence `first_seen`/`first_status` below, not "last".
    const target = input.offset + input.limit;
    const fetchLimit = input.exclude_errors ? Math.min(target * 3, 2000) : target;
    const { rows, hasMore } = await queryCdx(env, {
      url: input.url,
      matchType: input.match_type,
      from: input.from,
      to: input.to,
      collapse: "urlkey",
      limit: fetchLimit,
      offset: 0,
    });

    let items = rows.map((row) => ({
      url: row.original,
      first_seen: cdxTimestampToIso(row.timestamp),
      first_status: row.statuscode,
    }));
    if (input.exclude_errors) {
      items = items.filter((item) => !item.first_status.startsWith("4") && !item.first_status.startsWith("5"));
    }

    const page = items.slice(input.offset, input.offset + input.limit);
    const pageHasMore = hasMore || input.offset + page.length < items.length;

    return jsonResult({
      items: page,
      has_more: pageHasMore,
      next_offset: pageHasMore ? input.offset + page.length : null,
      notice: hasMore
        ? "This site has more captured URLs than were scanned for this page; results may be incomplete. Narrow with `from`/`to` or a longer `url` prefix."
        : "",
      attribution: attribution("Internet Archive Wayback Machine", { url: "https://web.archive.org/" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
