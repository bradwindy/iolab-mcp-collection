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
import { ItemNotFoundError, LendingRestrictedError } from "../clients/archiveOrg.js";
import { getItemFullText, NoFullTextFileError } from "../itemText.js";

/** A character indexOf could match adjacent to, that should NOT count as a word boundary. */
const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;

export const searchInsideTextInputShape = {
  identifier: z.string().min(1).describe("The archive.org item identifier to search within."),
  query: z.string().min(1).describe("Text to search for within the item's full text (case-insensitive)."),
  whole_word: z
    .boolean()
    .default(true)
    .describe(
      "Match `query` only at word boundaries (default). E.g. 'moa' won't match inside 'moans' or 'amoaing'. " +
        "Set false for a raw substring match, e.g. to deliberately find a word fragment or prefix/suffix.",
    ),
  context_chars: z.number().int().min(20).max(2000).default(200).describe("Characters of surrounding context to include per match."),
  limit: limitParam(50, 10),
  offset: offsetParam,
};

export const searchInsideTextOutputShape = {
  identifier: z.string(),
  query: z.string(),
  matches: z.array(z.object({ char_offset: z.number(), passage: z.string() })),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchInsideTextInputShape);

export async function searchInsideTextHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const fullText = await getItemFullText(env, input.identifier);
    const needle = input.query.toLowerCase();
    const haystack = fullText.toLowerCase();

    const allOffsets: number[] = [];
    let searchFrom = 0;
    while (true) {
      const found = haystack.indexOf(needle, searchFrom);
      if (found === -1) break;
      if (!input.whole_word || (!WORD_CHAR.test(haystack[found - 1] ?? "") && !WORD_CHAR.test(haystack[found + needle.length] ?? ""))) {
        allOffsets.push(found);
      }
      searchFrom = found + needle.length;
    }

    const page = allOffsets.slice(input.offset, input.offset + input.limit);
    const pageInfo = describePage({ returned: page.length, total_count: allOffsets.length, offset: input.offset });

    const matches = page.map((charOffset) => {
      const start = Math.max(0, charOffset - input.context_chars);
      const end = Math.min(fullText.length, charOffset + input.query.length + input.context_chars);
      return { char_offset: charOffset, passage: fullText.slice(start, end).trim() };
    });

    return jsonResult({
      identifier: input.identifier,
      query: input.query,
      matches,
      ...pageInfo,
      attribution: attribution("archive.org", { url: `https://archive.org/details/${input.identifier}` }),
    });
  } catch (error) {
    if (error instanceof ItemNotFoundError) {
      return { content: [{ type: "text", text: `${error.message} Check the identifier with ia_search_items.` }], isError: true };
    }
    if (error instanceof LendingRestrictedError) {
      return {
        content: [
          {
            type: "text",
            text: `${error.message} Its full text is not publicly downloadable — only public-domain and openly-licensed items expose full text this way.`,
          },
        ],
        isError: true,
      };
    }
    if (error instanceof NoFullTextFileError) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
