import { z } from "zod";
import {
  attribution,
  describePage,
  jsonResult,
  limitParam,
  offsetParam,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { advancedSearch, DeepPaginationError } from "../clients/archiveOrg.js";

export const searchItemsInputShape = {
  query: z.string().min(1).describe("Lucene query, e.g. 'title:(apollo)' or a plain keyword search."),
  mediatype: z
    .enum(["texts", "movies", "audio", "image", "software", "web", "data", "collection"])
    .optional()
    .describe("Restrict to one archive.org media type."),
  collection: z.string().optional().describe("Restrict to items in this collection, e.g. 'nasa'."),
  year_from: z.number().int().optional().describe("Earliest publication year to include."),
  year_to: z.number().int().optional().describe("Latest publication year to include."),
  sort: z
    .string()
    .default("identifier asc")
    .describe("Explicit sort, e.g. 'identifier asc' or 'date desc' — always required for stable pagination."),
  limit: limitParam(100, 20),
  offset: offsetParam,
};

export const searchItemsOutputShape = {
  items: z.array(
    z.object({
      identifier: z.string(),
      title: z.string().optional(),
      creator: z.union([z.string(), z.array(z.string())]).optional(),
      date: z.string().optional(),
      mediatype: z.string().optional(),
      collection: z.union([z.string(), z.array(z.string())]).optional(),
      details_url: z.string(),
    }),
  ),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchItemsInputShape);

export async function searchItemsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const rows = Math.min(input.limit, 100); // advancedsearch.php's own page-size ceiling
  const page = Math.floor(input.offset / rows) + 1;

  if (input.offset % rows !== 0) {
    return {
      content: [
        {
          type: "text",
          text: "`offset` must be a multiple of `limit` for this tool — advancedsearch.php pages by whole pages, not arbitrary offsets. Use `next_offset` from a previous call.",
        },
      ],
      isError: true,
    };
  }

  try {
    const { numFound, docs } = await advancedSearch(env, {
      query: input.query,
      mediatype: input.mediatype,
      collection: input.collection,
      yearFrom: input.year_from,
      yearTo: input.year_to,
      sort: input.sort,
      rows,
      page,
    });

    const items = docs.map((doc) => ({
      identifier: doc.identifier,
      title: doc.title,
      creator: doc.creator,
      date: doc.date,
      mediatype: doc.mediatype,
      collection: doc.collection,
      details_url: `https://archive.org/details/${doc.identifier}`,
    }));

    const pageInfo = describePage({ returned: items.length, total_count: numFound, offset: input.offset });

    return jsonResult({
      items,
      ...pageInfo,
      notice:
        pageInfo.has_more && input.offset + items.length >= 10000
          ? "Approaching archive.org's deep-pagination limit (~10,000 rows) — narrow with `mediatype`, `collection`, or a year range instead of paging further."
          : "",
      attribution: attribution("archive.org", { url: "https://archive.org/" }),
    });
  } catch (error) {
    if (error instanceof DeepPaginationError) {
      return {
        content: [{ type: "text", text: `${error.message} Narrow with \`mediatype\`, \`collection\`, or a year range.` }],
        isError: true,
      };
    }
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
