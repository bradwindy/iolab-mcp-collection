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
    .describe("Drop URLs whose most recent capture 4xx/5xx'd — raw domain/prefix queries otherwise return large volumes of dead links."),
  limit: limitParam(200, 50),
  offset: offsetParam,
};

export const waybackListSiteUrlsOutputShape = {
  items: z.array(z.object({ url: z.string(), last_seen: z.string(), last_status: z.string() })),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(waybackListSiteUrlsInputShape);

export async function waybackListSiteUrlsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    // exclude_errors is filtered client-side, not via a CDX `filter=statuscode:2..` regex — that
    // regex form wasn't verified live, and client-side filtering after `collapse=urlkey` (one row
    // per distinct URL, its most recent capture) is simple and unambiguous.
    const fetchLimit = input.exclude_errors ? Math.min(input.limit * 3, 500) : input.limit;
    const { rows, hasMore } = await queryCdx(env, {
      url: input.url,
      matchType: input.match_type,
      from: input.from,
      to: input.to,
      collapse: "none",
      limit: fetchLimit,
      offset: 0,
    });

    // collapse=urlkey isn't passed to queryCdx (it only dedupes consecutive rows sharing a key,
    // and we want the LAST capture per URL, not the first) — dedupe here instead, keeping each
    // URL's most recent row.
    const latestByUrl = new Map<string, (typeof rows)[number]>();
    for (const row of rows) latestByUrl.set(row.original, row);

    let items = [...latestByUrl.values()].map((row) => ({
      url: row.original,
      last_seen: cdxTimestampToIso(row.timestamp),
      last_status: row.statuscode,
    }));
    if (input.exclude_errors) {
      items = items.filter((item) => !item.last_status.startsWith("4") && !item.last_status.startsWith("5"));
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
