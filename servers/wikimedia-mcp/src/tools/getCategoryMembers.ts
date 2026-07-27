import { z } from "zod";
import { jsonResult, limitParam, type ToolTextResult } from "@iolab/mcp-kit";
import { fetchCategoryMembers } from "../clients/wiki.js";
import { langParam, projectParam } from "../projects.js";
import { mapCommonWikiError, attributionSchema, wikiAttribution, wikiTarget } from "../toolSupport.js";

export const getCategoryMembersInputShape = {
  category: z
    .string()
    .min(1)
    .describe("Category name, with or without the 'Category:' prefix, e.g. 'Birds of New Zealand'."),
  type: z
    .enum(["page", "subcat", "file"])
    .default("page")
    .describe("'page' lists articles in the category, 'subcat' lists subcategories, 'file' lists media files."),
  namespace: z.number().int().min(0).optional().describe("Restrict to one namespace. Omit for all."),
  project: projectParam,
  lang: langParam,
  limit: limitParam(100, 25),
  cursor: z
    .string()
    .optional()
    .describe("Pass the `next_cursor` from a previous call to fetch the following page. This list is cursor-paginated, not offset-paginated."),
};

export const getCategoryMembersOutputShape = {
  members: z.array(
    z.object({ title: z.string(), pageid: z.number().optional(), namespace: z.number(), type: z.string().optional(), added: z.string().optional() }),
  ),
  category: z.string(),
  wiki: z.string(),
  returned: z.number(),
  has_more: z.boolean(),
  /** Opaque continuation token — see wikimedia_get_backlinks for why this isn't an offset. */
  next_cursor: z.string().nullable(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getCategoryMembersInputShape);

export async function getCategoryMembersHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const { host } = wikiTarget(input.project, input.lang);

  // `cmtitle` is rejected outright without a namespace prefix, which is an easy thing for a caller
  // to omit — normalise rather than erroring.
  //
  // The test is "does it already carry any namespace prefix", not "does it start with 'Category:'":
  // every wiki has a localised alias for namespace 14 (`Catégorie:` on frwiki, `Kategorie:` on
  // dewiki — confirmed against each wiki's own siteinfo), so matching only the English form would
  // turn `Catégorie:Oiseaux` into the nonexistent `Category:Catégorie:Oiseaux`. The canonical
  // `Category:` prefix is accepted by every wiki, which is why it is safe to add to a bare name.
  const trimmed = input.category.trim();
  const category = trimmed.includes(":") ? trimmed : `Category:${trimmed}`;

  try {
    const { rows, next_cursor } = await fetchCategoryMembers(env, host, {
      category,
      type: input.type,
      namespace: input.namespace,
      limit: input.limit,
      cursor: input.cursor,
    });

    return jsonResult({
      members: rows.map((row) => ({
        title: row.title,
        ...(row.pageid !== undefined ? { pageid: row.pageid } : {}),
        namespace: row.ns,
        ...(row.type !== undefined ? { type: row.type } : {}),
        ...(row.timestamp !== undefined ? { added: row.timestamp } : {}),
      })),
      category,
      wiki: host,
      returned: rows.length,
      has_more: next_cursor !== null,
      next_cursor,
      attribution: wikiAttribution(input.project, host),
    });
  } catch (error) {
    const mapped = mapCommonWikiError(
      error,
      "Confirm the category exists with wikimedia_search_pages using `namespace: 14`, which searches category pages.",
    );
    if (mapped) return mapped;
    throw error;
  }
}
