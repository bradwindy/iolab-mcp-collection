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
import { searchOpenLibrary } from "../clients/openLibrary.js";

export const openlibrarySearchInputShape = {
  query: z.string().min(1).describe("Title, author, or general search query."),
  limit: limitParam(50, 10),
  offset: offsetParam,
};

export const openlibrarySearchOutputShape = {
  items: z.array(
    z.object({
      title: z.string(),
      author_name: z.array(z.string()).optional(),
      first_publish_year: z.number().optional(),
      edition_count: z.number().optional(),
      archive_org_identifiers: z.array(z.string()),
    }),
  ),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(openlibrarySearchInputShape);

export async function openlibrarySearchHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const { numFound, docs } = await searchOpenLibrary(env, { query: input.query, limit: input.limit, offset: input.offset });

    const items = docs.map((doc) => ({
      title: doc.title,
      author_name: doc.author_name,
      first_publish_year: doc.first_publish_year,
      edition_count: doc.edition_count,
      // The bridge into ia_get_item / ia_search_inside_text — confirmed live present in real
      // Open Library search responses.
      archive_org_identifiers: doc.ia ?? [],
    }));

    const pageInfo = describePage({ returned: items.length, total_count: numFound, offset: input.offset });

    return jsonResult({
      items,
      ...pageInfo,
      attribution: attribution("Open Library", { url: "https://openlibrary.org/" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
