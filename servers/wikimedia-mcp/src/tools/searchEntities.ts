import { z } from "zod";
import { attribution, jsonResult, limitParam, offsetParam, type ToolTextResult } from "@iolab/mcp-kit";
import { entityUrl, searchEntities } from "../clients/wikidata.js";
import { mapCommonWikiError, attributionSchema } from "../toolSupport.js";

export const searchEntitiesInputShape = {
  query: z.string().min(1).describe("Name, alias, or label to look up, e.g. 'kiwi bird' or 'date of birth'."),
  type: z
    .enum(["item", "property"])
    .default("item")
    .describe("'item' finds things (Q-ids); 'property' finds the relationships used in statements (P-ids), e.g. 'instance of' is P31."),
  language: z.string().min(2).max(20).default("en").describe("Language to match labels and aliases in, and to return them in."),
  limit: limitParam(50, 10),
  offset: offsetParam,
};

export const searchEntitiesOutputShape = {
  entities: z.array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      description: z.string().optional(),
      /** How the query matched: 'label', 'alias', or 'entityId' — an alias match explains a surprising result. */
      matched_on: z.string().optional(),
      matched_text: z.string().optional(),
      /**
       * Which language `matched_text` is in. Set only when it differs from `language`, which is the
       * confusing case: asking in German and getting a German label back beside the English alias
       * that actually matched reads as a bug otherwise.
       */
      matched_language: z.string().optional(),
      url: z.string(),
    }),
  ),
  returned: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  attribution: attributionSchema,
};

const inputSchema = z.object(searchEntitiesInputShape);

export async function searchEntitiesHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const { hits, has_more, next_offset } = await searchEntities(env, {
      search: input.query,
      language: input.language,
      type: input.type,
      limit: input.limit,
      offset: input.offset,
    });

    return jsonResult({
      entities: hits.map((hit) => ({
        id: hit.id,
        ...(hit.label !== undefined ? { label: hit.label } : {}),
        ...(hit.description !== undefined ? { description: hit.description } : {}),
        ...(hit.match?.type !== undefined ? { matched_on: hit.match.type } : {}),
        ...(hit.match?.text !== undefined ? { matched_text: hit.match.text } : {}),
        ...(hit.match?.language !== undefined && hit.match.language !== input.language ? { matched_language: hit.match.language } : {}),
        url: entityUrl(hit.id),
      })),
      returned: hits.length,
      has_more,
      // `search-continue` is the offset to resume from, echoed back rather than recomputed as
      // `offset + hits.length`: the API can consume more of the result space than it returns hits
      // for, so recomputing it silently skips matches.
      next_offset,
      attribution: attribution("Wikidata", { license: "CC0 1.0", url: "https://www.wikidata.org/" }),
    });
  } catch (error) {
    const mapped = mapCommonWikiError(error, "Try a shorter or more common name, or switch `type` between 'item' and 'property'.");
    if (mapped) return mapped;
    throw error;
  }
}
