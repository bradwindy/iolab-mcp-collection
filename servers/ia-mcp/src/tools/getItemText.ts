import { z } from "zod";
import { attribution, jsonResult, UpstreamHttpError, upstreamError, type ToolTextResult } from "@iolab/mcp-kit";
import { LendingRestrictedError } from "../clients/archiveOrg.js";
import { getItemFullText, NoFullTextFileError } from "../itemText.js";

export const getItemTextInputShape = {
  identifier: z.string().min(1).describe("The archive.org item identifier to read the full text of."),
  char_offset: z.number().int().min(0).default(0).describe("Character offset to resume reading from."),
  max_chars: z.number().int().min(500).max(50000).default(10000).describe("Max characters to return in this page."),
};

export const getItemTextOutputShape = {
  identifier: z.string(),
  content: z.string(),
  char_offset: z.number(),
  next_offset: z.number().nullable(),
  total_chars: z.number(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getItemTextInputShape);

export async function getItemTextHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const fullText = await getItemFullText(env, input.identifier);
    const slice = fullText.slice(input.char_offset, input.char_offset + input.max_chars);
    const nextOffset = input.char_offset + slice.length < fullText.length ? input.char_offset + slice.length : null;

    return jsonResult({
      identifier: input.identifier,
      content: slice,
      char_offset: input.char_offset,
      next_offset: nextOffset,
      total_chars: fullText.length,
      attribution: attribution("archive.org", { url: `https://archive.org/details/${input.identifier}` }),
    });
  } catch (error) {
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
