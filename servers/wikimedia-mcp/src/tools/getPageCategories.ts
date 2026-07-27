import { z } from "zod";
import { CACHE_TTL, cached, jsonResult, limitParam, offsetParam, paginate, type ToolTextResult } from "@iolab/mcp-kit";
import { CATEGORY_FETCH_LIMIT, fetchPageCategories } from "../clients/wiki.js";
import { langParam, projectParam } from "../projects.js";
import { mapCommonWikiError, attributionSchema, wikiAttribution, wikiTarget } from "../toolSupport.js";

/** Declared once so the advertised limit and the enforced limit cannot drift apart. */
const CATEGORY_BOUNDS = { maxLimit: 100, defaultLimit: 50 } as const;

export const getPageCategoriesInputShape = {
  title: z.string().min(1).describe("Exact page title. Redirects are resolved automatically."),
  include_hidden: z
    .boolean()
    .default(false)
    .describe(
      "Include maintenance categories ('All articles with unsourced statements' and similar). These are hidden from readers " +
        "and usually noise, but useful when auditing article quality.",
    ),
  project: projectParam,
  lang: langParam,
  limit: limitParam(CATEGORY_BOUNDS.maxLimit, CATEGORY_BOUNDS.defaultLimit),
  offset: offsetParam,
};

export const getPageCategoriesOutputShape = {
  categories: z.array(z.object({ title: z.string(), hidden: z.boolean() })),
  /** The title the categories actually belong to, after any redirect. */
  title: z.string(),
  /** Set when the requested title was whitespace/capitalisation-normalised before lookup. */
  normalized_from: z.string().nullable(),
  /** Set when the (normalised) title redirected. Distinct from normalisation — both can apply. */
  redirected_from: z.string().nullable(),
  wiki: z.string(),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getPageCategoriesInputShape);

export async function getPageCategoriesHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const { host } = wikiTarget(input.project, input.lang);

  try {
    // The full set is fetched in one call and filtered/paginated here rather than pushing
    // `clshow=!hidden` and `cllimit` upstream. Confirmed live that the upstream filter is applied
    // *after* the limit window and reports no continuation, so a small `cllimit` silently returns
    // far fewer visible categories than the page actually has — see CATEGORY_FETCH_LIMIT.
    const { rows, truncated, resolvedTitle, resolution } = await cached(
      env.MCP_CACHE,
      `wikimedia:cats:${host}:${input.title}`,
      CACHE_TTL.SLOW_MOVING,
      () => fetchPageCategories(env, host, input.title),
    );

    const visible = input.include_hidden ? rows : rows.filter((row) => row.hidden !== true);
    const page = paginate(visible, { limit: input.limit, offset: input.offset }, CATEGORY_BOUNDS);

    return jsonResult({
      categories: page.items.map((row) => ({ title: row.title, hidden: row.hidden === true })),
      title: resolvedTitle,
      normalized_from: resolution.normalized_from,
      redirected_from: resolution.redirected_from,
      wiki: host,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncated
        ? `This page has more than ${CATEGORY_FETCH_LIMIT} categories; only the first ${CATEGORY_FETCH_LIMIT} were read, so counts here are a lower bound.`
        : "",
      attribution: wikiAttribution(input.project, host),
    });
  } catch (error) {
    const mapped = mapCommonWikiError(error, "Use wikimedia_search_pages to confirm the exact page title.");
    if (mapped) return mapped;
    throw error;
  }
}
