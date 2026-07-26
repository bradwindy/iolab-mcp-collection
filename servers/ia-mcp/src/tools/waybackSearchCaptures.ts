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
import { archivedUrl, cdxTimestampToIso, queryCdx } from "../clients/wayback.js";

export const waybackSearchCapturesInputShape = {
  url: z.string().min(1).describe("The URL to search Wayback Machine captures for."),
  match_type: z
    .enum(["exact", "prefix", "host", "domain"])
    .default("exact")
    .describe("'exact' matches only this URL; 'prefix' matches this URL and anything under it; 'host'/'domain' match the whole host."),
  from: z.string().regex(/^\d{4,14}$/).optional().describe("Earliest capture, YYYY[MMDDHHMMSS] (e.g. '2015' or '20150101')."),
  to: z.string().regex(/^\d{4,14}$/).optional().describe("Latest capture, same format as `from`."),
  status_filter: z.string().optional().describe("Exact HTTP status code to require, e.g. '200'."),
  mime_filter: z.string().optional().describe("Exact MIME type to require, e.g. 'text/html'."),
  collapse: z
    .enum(["none", "hour", "day", "month", "year", "digest"])
    .default("none")
    .describe("Collapse multiple captures per time bucket (or per content digest) into one row."),
  limit: limitParam(200, 20),
  offset: offsetParam,
};

export const waybackSearchCapturesOutputShape = {
  items: z.array(
    z.object({
      timestamp: z.string(),
      iso_date: z.string(),
      original: z.string(),
      mimetype: z.string(),
      statuscode: z.string(),
      digest: z.string(),
      length: z.string(),
      archived_url: z.string(),
    }),
  ),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(waybackSearchCapturesInputShape);

export async function waybackSearchCapturesHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const { rows, hasMore } = await queryCdx(env, {
      url: input.url,
      matchType: input.match_type,
      from: input.from,
      to: input.to,
      statusFilter: input.status_filter,
      mimeFilter: input.mime_filter,
      collapse: input.collapse,
      limit: input.limit,
      offset: input.offset,
    });

    const items = rows.map((row) => ({
      timestamp: row.timestamp,
      iso_date: cdxTimestampToIso(row.timestamp),
      original: row.original,
      mimetype: row.mimetype,
      statuscode: row.statuscode,
      digest: row.digest,
      length: row.length,
      archived_url: archivedUrl(row.timestamp, row.original),
    }));

    return jsonResult({
      items,
      has_more: hasMore,
      next_offset: hasMore ? input.offset + items.length : null,
      notice: hasMore
        ? "More captures exist; page with `offset`. `digest` lets you spot which captures actually changed content without fetching each page."
        : "",
      attribution: attribution("Internet Archive Wayback Machine", { url: "https://web.archive.org/" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
