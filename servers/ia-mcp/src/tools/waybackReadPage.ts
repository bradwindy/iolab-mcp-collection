import { z } from "zod";
import { attribution, jsonResult, UpstreamHttpError, upstreamError, type ToolTextResult } from "@iolab/mcp-kit";
import { archivedUrl, cdxTimestampToIso } from "../clients/wayback.js";
import { fetchAndExtractPage, LATEST_SENTINEL } from "../pageFetch.js";

export const waybackReadPageInputShape = {
  url: z.string().min(1).describe("The URL to read an archived capture of."),
  timestamp: z
    .string()
    .regex(/^\d{1,14}$/)
    .optional()
    .describe("Capture timestamp, YYYY[MMDDHHMMSS]. Omit for the most recent capture."),
  format: z
    .enum(["text", "markdown", "links", "raw_html"])
    .default("text")
    .describe("'text' strips markup; 'markdown' keeps heading structure; 'links' lists every hyperlink; 'raw_html' returns the unmodified capture."),
  max_chars: z.number().int().min(500).max(100000).default(15000).describe("Max characters to return in this page of content."),
  char_offset: z.number().int().min(0).default(0).describe("Character offset to resume reading from, for paging through a long page."),
};

export const waybackReadPageOutputShape = {
  url: z.string(),
  requested_timestamp: z.string().nullable(),
  actual_timestamp: z.string(),
  actual_iso_date: z.string(),
  archived_url: z.string(),
  format: z.string(),
  content: z.string(),
  char_offset: z.number(),
  next_char_offset: z.number().nullable(),
  total_chars: z.number(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(waybackReadPageInputShape);

export async function waybackReadPageHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const requestedTimestamp = input.timestamp ?? LATEST_SENTINEL;

  try {
    const page = await fetchAndExtractPage(env, input.url, requestedTimestamp);

    const full =
      input.format === "raw_html"
        ? page.html
        : input.format === "markdown"
          ? page.markdown
          : input.format === "links"
            ? JSON.stringify(page.links, null, 2)
            : page.text;

    const slice = full.slice(input.char_offset, input.char_offset + input.max_chars);
    const nextOffset = input.char_offset + slice.length < full.length ? input.char_offset + slice.length : null;

    return jsonResult({
      url: input.url,
      requested_timestamp: input.timestamp ?? null,
      actual_timestamp: page.actualTimestamp,
      actual_iso_date: cdxTimestampToIso(page.actualTimestamp),
      archived_url: archivedUrl(page.actualTimestamp, input.url),
      format: input.format,
      content: slice,
      char_offset: input.char_offset,
      next_char_offset: nextOffset,
      total_chars: full.length,
      attribution: attribution("Internet Archive Wayback Machine", { url: "https://web.archive.org/" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
