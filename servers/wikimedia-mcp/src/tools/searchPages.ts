import { z } from "zod";
import { describePage, jsonResult, limitParam, offsetParam, toolError, type ToolTextResult } from "@iolab/mcp-kit";
import { buildSearchQuery, searchPages, SEARCH_OFFSET_CEILING } from "../clients/wiki.js";
import { stripInlineHtml } from "../html.js";
import { langParam, projectParam } from "../projects.js";
import { hasFoldableDiacritic } from "../text.js";
import { mapCommonWikiError, attributionSchema, wikiAttribution, wikiPageUrl, wikiTarget } from "../toolSupport.js";

export const searchPagesInputShape = {
  query: z
    .string()
    .optional()
    .describe(
      "Free-text search terms. Also accepts raw CirrusSearch syntax for operators this tool has no " +
        "structured parameter for, e.g. 'insource:/Apteryx [a-z]+/', 'hastemplate:Taxobox', 'linksto:Kiwi_(bird)'.",
    ),
  in_title: z.string().optional().describe("Only match pages whose title contains this text."),
  in_category: z.string().optional().describe("Only match pages in this category, e.g. 'Birds of New Zealand' (no 'Category:' prefix)."),
  in_category_deep: z
    .boolean()
    .default(false)
    .describe("Search subcategories of `in_category` too (up to 5 levels, 256 categories). Slower and can time out on huge trees."),
  in_source: z
    .string()
    .optional()
    .describe("Only match pages whose raw wikitext contains this exact phrase — finds template usage and citations that plain search misses."),
  more_like: z
    .string()
    .optional()
    .describe("Find pages similar to this exact page title. This is the supported replacement for the removed 'related pages' endpoint."),
  edited_after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date like 2025-01-31.")
    .optional()
    .describe("Only match pages last edited on or after this date (YYYY-MM-DD). The date itself is included."),
  match: z
    .enum(["relaxed", "all"])
    .default("relaxed")
    .describe(
      "How many of the query's terms a page must contain. 'relaxed' (the default) requires all of them for " +
        "queries of three terms or fewer, allows one miss at four or five, and half at six or more — so a long " +
        "descriptive query degrades gracefully instead of returning nothing when a single word is absent. " +
        "'all' requires every term, which is stricter and can return zero results for a query that describes " +
        "the right page in words the article happens not to use.",
    ),
  namespace: z.number().int().min(0).default(0).describe("Wiki namespace to search. 0 is articles; 14 is categories."),
  sort: z
    .enum([
      "relevance",
      "title_natural_asc",
      "title_natural_desc",
      "create_timestamp_asc",
      "create_timestamp_desc",
      "last_edit_asc",
      "last_edit_desc",
      "incoming_links_desc",
    ])
    .default("relevance")
    .describe(
      "Result ordering. 'relevance' is scored at query time, so paging deep through a large result set can shift rows " +
        "between pages; use 'title_natural_asc' or 'create_timestamp_asc' when you need a stable sequence across calls.",
    ),
  project: projectParam,
  lang: langParam,
  limit: limitParam(50, 20),
  offset: offsetParam,
};

export const searchPagesOutputShape = {
  results: z.array(
    z.object({
      title: z.string(),
      pageid: z.number(),
      snippet: z.string(),
      size_bytes: z.number().optional(),
      word_count: z.number().optional(),
      last_edited: z.string().optional(),
      url: z.string(),
    }),
  ),
  effective_query: z.string(),
  /** What was changed to rescue a zero-result search, or null when the first attempt succeeded. */
  fallback_applied: z.string().nullable(),
  /**
   * CirrusSearch's own "did you mean". Advisory: it is generated against an already-folded index, so
   * it is blind to diacritics and its output is noise for macronised queries — see the handler.
   */
  did_you_mean: z.string().optional(),
  wiki: z.string(),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  attribution: attributionSchema,
};

const inputSchema = z.object(searchPagesInputShape);

export async function searchPagesHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const { host } = wikiTarget(input.project, input.lang);

  const search = buildSearchQuery(input);
  if (search.length === 0) {
    return toolError(
      "No search criteria supplied.",
      "Set at least one of `query`, `in_title`, `in_category`, `in_source`, or `more_like`.",
    );
  }

  // CirrusSearch errors rather than truncating past its 10,000-result ceiling; catching it here
  // costs nothing and gives a better message than the upstream error code would.
  if (input.offset + input.limit > SEARCH_OFFSET_CEILING) {
    return toolError(
      `Wikimedia search cannot page beyond ${SEARCH_OFFSET_CEILING} results (offset ${input.offset} + limit ${input.limit} exceeds it).`,
      "Narrow the search with `in_category`, `in_title`, or `edited_after` instead of paging further.",
    );
  }

  try {
    const query = {
      search,
      namespace: input.namespace,
      sort: input.sort,
      limit: input.limit,
      offset: input.offset,
      match: input.match,
    };

    let result = await searchPages(env, host, query);
    let fallbackApplied: string | null = null;

    // Zero-result rescue. Deliberately NOT client-side term dropping: `match: "relaxed"` already
    // asks CirrusSearch to drop the weakest terms, and the server knows the IDFs. What is left to
    // try is the service's own spelling correction, which `srenablerewrites` runs and then re-queries
    // with, returning the corrected rows rather than just naming them.
    //
    // Only on a first page — a later page legitimately runs out of results, and silently swapping in
    // a different query mid-pagination would interleave two unrelated result sets.
    if (result.total_hits === 0 && input.offset === 0) {
      const rewritten = await searchPages(env, host, { ...query, enableRewrites: true });
      if (rewritten.total_hits > 0) {
        result = rewritten;
        fallbackApplied = rewritten.rewritten_query
          ? `No results for the query as written; the search service corrected it to '${rewritten.rewritten_query}' and those results are shown.`
          : "No results for the query as written; the search service's own query rewriting was enabled and those results are shown.";
      }
    }

    const { hits, total_hits } = result;

    // The phrase suggester runs against the folded index, so a diacritic difference has zero edit
    // distance to it and it spends its budget elsewhere. Live, it turns `Taupō` into `tampa`,
    // `Opepe` into `opera`, and `Ōpepe Taupō` into `ōhope tampa`. Passing that on for a te reo Māori
    // place name is worse than saying nothing, so it is dropped whenever the query carries a
    // foldable diacritic.
    const suggestion = result.suggestion !== undefined && !hasFoldableDiacritic(search) ? stripInlineHtml(result.suggestion) : undefined;

    const results = hits.map((hit) => ({
      title: hit.title,
      pageid: hit.pageid,
      // Snippets arrive wrapped in <span class="searchmatch"> with HTML-escaped punctuation.
      snippet: stripInlineHtml(hit.snippet ?? ""),
      ...(hit.size !== undefined ? { size_bytes: hit.size } : {}),
      ...(hit.wordcount !== undefined ? { word_count: hit.wordcount } : {}),
      ...(hit.timestamp !== undefined ? { last_edited: hit.timestamp } : {}),
      url: wikiPageUrl(host, hit.title),
    }));

    const pageInfo = describePage({ returned: results.length, total_count: total_hits, offset: input.offset });

    return jsonResult({
      results,
      effective_query: search,
      fallback_applied: fallbackApplied,
      ...(suggestion !== undefined ? { did_you_mean: suggestion } : {}),
      wiki: host,
      ...pageInfo,
      attribution: wikiAttribution(input.project, host),
    });
  } catch (error) {
    const mapped = mapCommonWikiError(error, "Check the spelling of any category or title filter, or widen the search.");
    if (mapped) return mapped;
    throw error;
  }
}
