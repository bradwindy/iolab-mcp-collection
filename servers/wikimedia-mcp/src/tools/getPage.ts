import { z } from "zod";
import { CACHE_TTL, cached, jsonResult, type ToolTextResult } from "@iolab/mcp-kit";
import { fetchPageExtract, fetchPageLinks, fetchSectionHtml, fetchSectionOutline, type TocSection } from "../clients/wiki.js";
import { htmlToPlainText } from "../html.js";
import { langParam, projectParam } from "../projects.js";
import { mapCommonWikiError, attributionSchema, wikiAttribution, wikiPageUrl, wikiTarget } from "../toolSupport.js";

export const getPageInputShape = {
  title: z.string().min(1).describe("Exact page title, e.g. 'Kiwi (bird)'. Redirects and capitalisation are resolved automatically."),
  section: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Read only one section, identified by the `index` value from a previous call's `sections` outline. " +
        "Omit to read the whole page. Use '0' for the lead section alone.",
    ),
  project: projectParam,
  lang: langParam,
  max_chars: z
    .number()
    .int()
    .min(500)
    .max(60000)
    .default(40000)
    .describe(
      "Character budget for a whole-page read. Above it the tool returns the section outline instead of the text, " +
        "so a very long article can be read section by section rather than flooding the context. Ignored when `section` is set.",
    ),
};

export const getPageOutputShape = {
  title: z.string(),
  wiki: z.string(),
  url: z.string(),
  /** Set when the requested title was whitespace/capitalisation-normalised before lookup. */
  normalized_from: z.string().nullable(),
  /** Set when the (normalised) title redirected. Distinct from normalisation — both can apply. */
  redirected_from: z.string().nullable(),
  description: z.string().optional(),
  wikibase_item: z.string().optional(),
  is_disambiguation: z.boolean(),
  /** Present only for a disambiguation page: the articles it points at. */
  disambiguation_options: z.array(z.string()).optional(),
  section: z.string().nullable(),
  section_title: z.string().nullable(),
  /** True when the page was too long to return whole; `sections` is populated instead of `text`. */
  outline_only: z.boolean(),
  text: z.string(),
  sections: z
    .array(z.object({ index: z.string(), level: z.number(), number: z.string(), title: z.string(), anchor: z.string() }))
    .optional(),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getPageInputShape);

export async function getPageHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const { host } = wikiTarget(input.project, input.lang);

  try {
    // Fetched first regardless of mode: it resolves redirects/normalisation and classifies the page,
    // and its lead extract is what a disambiguation page or an overflowing article falls back to.
    //
    // The key's mode must be derived with the same test the fetch uses (`!== undefined`, not
    // truthiness) or the two disagree and an intro-only extract gets cached under the full-article
    // key — after which a plain whole-page read silently returns just the lead for the whole TTL.
    const introOnly = input.section !== undefined;
    const summary = await cached(env.MCP_CACHE, `wikimedia:extract:${host}:${introOnly ? "intro" : "full"}:${input.title}`, CACHE_TTL.SLOW_MOVING, () =>
      fetchPageExtract(env, host, { title: input.title, introOnly }),
    );

    const resolvedTitle = summary.page.title;
    const base = {
      title: resolvedTitle,
      wiki: host,
      url: summary.canonical_url ?? wikiPageUrl(host, resolvedTitle),
      normalized_from: summary.resolution.normalized_from,
      redirected_from: summary.resolution.redirected_from,
      ...(summary.description !== undefined ? { description: summary.description } : {}),
      ...(summary.wikibase_item !== undefined ? { wikibase_item: summary.wikibase_item } : {}),
      is_disambiguation: summary.is_disambiguation,
      attribution: wikiAttribution(input.project, host),
    };

    // A disambiguation page's prose reads like an answer but is a list of unrelated topics. Return
    // the options instead so the model picks one rather than reporting the wrong subject.
    if (summary.is_disambiguation && input.section === undefined) {
      const options = await cached(env.MCP_CACHE, `wikimedia:dablinks:${host}:${resolvedTitle}`, CACHE_TTL.SLOW_MOVING, () =>
        fetchPageLinks(env, host, resolvedTitle),
      );
      return jsonResult({
        ...base,
        disambiguation_options: options,
        section: null,
        section_title: null,
        outline_only: false,
        text: summary.extract,
        notice: `'${resolvedTitle}' is a disambiguation page listing ${options.length} topics, not an article. Call this tool again with one of \`disambiguation_options\` as the title.`,
      });
    }

    if (input.section !== undefined) {
      const { html } = await cached(env.MCP_CACHE, `wikimedia:section:${host}:${resolvedTitle}:${input.section}`, CACHE_TTL.SLOW_MOVING, () =>
        fetchSectionHtml(env, host, resolvedTitle, input.section as string),
      );
      const text = await htmlToPlainText(html);
      const outline = await cachedOutline(env, host, resolvedTitle);
      const match = outline.find((entry) => entry.index === input.section);
      return jsonResult({
        ...base,
        section: input.section,
        section_title: match?.title ?? null,
        outline_only: false,
        text,
        notice: text.length === 0 ? `Section '${input.section}' rendered as empty. Check the \`index\` values from a whole-page call.` : "",
      });
    }

    if (summary.extract.length > input.max_chars) {
      const outline = await cachedOutline(env, host, resolvedTitle);
      return jsonResult({
        ...base,
        section: null,
        section_title: null,
        outline_only: true,
        // The lead alone is a useful answer on its own and costs nothing extra to include.
        text: summary.extract.slice(0, input.max_chars),
        sections: outline,
        notice:
          `'${resolvedTitle}' is ${summary.extract.length} characters, over the ${input.max_chars} budget, so only the ` +
          `opening text is shown. Call this tool again with \`section\` set to one of the \`index\` values above to read a specific part.`,
      });
    }

    return jsonResult({
      ...base,
      section: null,
      section_title: null,
      outline_only: false,
      text: summary.extract,
      notice: "",
    });
  } catch (error) {
    const mapped = mapCommonWikiError(
      error,
      "Use wikimedia_search_pages to find the exact title, and check `project` and `lang` point at the wiki you meant.",
    );
    if (mapped) return mapped;
    throw error;
  }
}

function cachedOutline(env: Env, host: string, title: string): Promise<TocSection[]> {
  return cached(env.MCP_CACHE, `wikimedia:toc:${host}:${title}`, CACHE_TTL.SLOW_MOVING, () => fetchSectionOutline(env, host, title));
}
