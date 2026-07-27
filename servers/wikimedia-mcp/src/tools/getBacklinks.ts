import { z } from "zod";
import { jsonResult, limitParam, type ToolTextResult } from "@iolab/mcp-kit";
import { fetchBacklinks } from "../clients/wiki.js";
import { langParam, projectParam } from "../projects.js";
import { mapCommonWikiError, attributionSchema, wikiAttribution, wikiTarget } from "../toolSupport.js";

export const getBacklinksInputShape = {
  title: z
    .string()
    .min(1)
    .describe("The page being linked to. For `transclusions` pass a template title ('Template:Taxobox'); for `file_usage` a file ('File:X.jpg')."),
  type: z
    .enum(["links_here", "transclusions", "file_usage"])
    .default("links_here")
    .describe(
      "'links_here' finds pages that link to this page; 'transclusions' finds pages that embed this template; " +
        "'file_usage' finds pages that display this file.",
    ),
  namespace: z.number().int().min(0).optional().describe("Restrict to one namespace. 0 is articles. Omit for all namespaces."),
  project: projectParam,
  lang: langParam,
  limit: limitParam(100, 25),
  cursor: z
    .string()
    .optional()
    .describe("Pass the `next_cursor` from a previous call to fetch the following page. This list is cursor-paginated, not offset-paginated."),
};

export const getBacklinksOutputShape = {
  links: z.array(z.object({ title: z.string(), pageid: z.number().optional(), namespace: z.number() })),
  target: z.string(),
  type: z.string(),
  wiki: z.string(),
  returned: z.number(),
  has_more: z.boolean(),
  /**
   * The opaque continuation token for the next page, or null at the end.
   *
   * Deliberately not `next_offset`: this Action API module has no offset parameter, only an opaque
   * cursor. Synthesising an offset would mean re-walking every prior page on each call — against an
   * API that permits one concurrent request — so the cursor is passed through honestly instead.
   */
  next_cursor: z.string().nullable(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getBacklinksInputShape);

export async function getBacklinksHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const { host } = wikiTarget(input.project, input.lang);

  try {
    const { rows, next_cursor } = await fetchBacklinks(env, host, {
      title: input.title,
      type: input.type,
      namespace: input.namespace,
      limit: input.limit,
      cursor: input.cursor,
    });

    return jsonResult({
      links: rows.map((row) => ({
        title: row.title,
        ...(row.pageid !== undefined ? { pageid: row.pageid } : {}),
        namespace: row.ns,
      })),
      target: input.title,
      type: input.type,
      wiki: host,
      returned: rows.length,
      has_more: next_cursor !== null,
      next_cursor,
      attribution: wikiAttribution(input.project, host),
    });
  } catch (error) {
    const mapped = mapCommonWikiError(
      error,
      "Check the title includes the right namespace prefix — 'Template:' for transclusions, 'File:' for file usage.",
    );
    if (mapped) return mapped;
    throw error;
  }
}
