import { z } from "zod";
import { CACHE_TTL, cached, jsonResult, toolError, type ToolTextResult } from "@iolab/mcp-kit";
import { fetchPageDocument, fetchPageExtract, fetchPageLinks } from "../clients/wiki.js";
import { LEAD_SECTION_INDEX, type ParsedDocument, type ParsedSection } from "../html.js";
import { langParam, projectParam } from "../projects.js";
import { mapCommonWikiError, attributionSchema, wikiAttribution, wikiPageUrl, wikiTarget } from "../toolSupport.js";

export const getPageInputShape = {
  title: z.string().min(1).describe("Exact page title, e.g. 'Kiwi (bird)'. Redirects and capitalisation are resolved automatically."),
  section: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(20)])
    .optional()
    .describe(
      "Read only these sections, identified by the `index` values from a previous call's `sections` outline. " +
        "Accepts one index or an array of them — several sections cost no more upstream requests than one, " +
        "so ask for everything you need at once. Omit to read the whole page. Use '0' for the lead section alone.",
    ),
  project: projectParam,
  lang: langParam,
  include_references: z
    .boolean()
    .default(false)
    .describe(
      "Also return the article's citations as structured rows — title, publication, year, authors, DOI, URL — " +
        "rather than leaving them to be read out of the prose. Useful for checking what an article actually cites.",
    ),
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

const referenceSchema = z.object({
  ref_id: z.string(),
  text: z.string(),
  title: z.string().optional(),
  publication: z.string().optional(),
  year: z.string().optional(),
  authors: z.array(z.string()).optional(),
  doi: z.string().optional(),
  pmid: z.string().optional(),
  bibcode: z.string().optional(),
  url: z.string().optional(),
});

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
  /** Present when more than one section was requested. */
  sections_read: z
    .array(z.object({ index: z.string(), title: z.string(), chars: z.number(), text: z.string() }))
    .optional(),
  /** True when the page was too long to return whole; `sections` is populated instead of `text`. */
  outline_only: z.boolean(),
  text: z.string(),
  sections: z
    .array(
      z.object({
        index: z.string(),
        level: z.number(),
        number: z.string(),
        title: z.string(),
        anchor: z.string(),
        /** Exact length of the text a `section` read of this index returns. */
        chars: z.number(),
      }),
    )
    .optional(),
  references: z.array(referenceSchema).optional(),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getPageInputShape);

export async function getPageHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const { host } = wikiTarget(input.project, input.lang);
  const requested = input.section === undefined ? undefined : normaliseSections(input.section);

  try {
    // Fetched first regardless of mode: it resolves redirects/normalisation and classifies the page,
    // and its lead extract is what a disambiguation page or an overflowing article falls back to.
    //
    // The key's mode must be derived with the same test the fetch uses (`!== undefined`, not
    // truthiness) or the two disagree and an intro-only extract gets cached under the full-article
    // key — after which a plain whole-page read silently returns just the lead for the whole TTL.
    const introOnly = requested !== undefined;
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
    // the options instead so the model picks one rather than reporting the wrong subject. The prose
    // itself is deliberately omitted — it restates the same list at roughly double the payload.
    if (summary.is_disambiguation && requested === undefined) {
      const options = await cached(env.MCP_CACHE, `wikimedia:dablinks:${host}:${resolvedTitle}`, CACHE_TTL.SLOW_MOVING, () =>
        fetchPageLinks(env, host, resolvedTitle),
      );
      return jsonResult({
        ...base,
        disambiguation_options: options,
        section: null,
        section_title: null,
        outline_only: false,
        text: "",
        notice: `'${resolvedTitle}' is a disambiguation page listing ${options.length} topics, not an article. Call this tool again with one of \`disambiguation_options\` as the title.`,
      });
    }

    if (requested !== undefined) {
      const document = await cachedDocument(env, host, resolvedTitle);
      const byIndex = new Map(document.sections.map((section) => [section.index, section]));
      const found = requested.map((index) => ({ index, section: byIndex.get(index) }));
      const missing = found.filter((entry) => entry.section === undefined).map((entry) => entry.index);
      const matched = found.flatMap((entry) => (entry.section === undefined ? [] : [entry.section]));

      if (matched.length === 0) {
        return toolError(
          `No section of '${resolvedTitle}' has ${missing.length === 1 ? `index '${missing[0]}'` : `any of the indexes ${missing.join(", ")}`}.`,
          "Call this tool without `section` to get the outline, and use the `index` values it reports.",
        );
      }

      const notices: string[] = [];
      if (missing.length > 0) notices.push(`No section matched ${missing.join(", ")}; the rest are returned.`);
      const empty = matched.filter((section) => section.chars === 0).map((section) => section.index);
      if (empty.length > 0) notices.push(`Section ${empty.join(", ")} rendered as empty.`);

      const single = matched.length === 1 ? (matched[0] as ParsedSection) : undefined;
      return jsonResult({
        ...base,
        section: single !== undefined ? single.index : requested.join(","),
        section_title: single?.title ?? null,
        ...(single === undefined
          ? {
              sections_read: matched.map((section) => ({
                index: section.index,
                title: section.title,
                chars: section.chars,
                text: section.text,
              })),
            }
          : {}),
        outline_only: false,
        text: single !== undefined ? single.text : matched.map((section) => section.text).join("\n\n"),
        ...(input.include_references ? { references: document.references } : {}),
        notice: notices.join(" "),
      });
    }

    if (summary.extract.length > input.max_chars || input.include_references) {
      // The outline's `chars` and any references both come from the parsed document, so both are
      // measured against exactly what a `section` read will return.
      const document = await cachedDocument(env, host, resolvedTitle);
      const outline = document.sections
        .filter((section) => section.index !== LEAD_SECTION_INDEX)
        .map((section) => ({
          index: section.index,
          level: section.level,
          number: section.number,
          title: section.title,
          anchor: section.anchor,
          chars: section.chars,
        }));

      if (summary.extract.length <= input.max_chars) {
        return jsonResult({
          ...base,
          section: null,
          section_title: null,
          outline_only: false,
          text: summary.extract,
          sections: outline,
          references: document.references,
          notice: "",
        });
      }

      return jsonResult({
        ...base,
        section: null,
        section_title: null,
        outline_only: true,
        // The lead alone is a useful answer on its own and costs nothing extra to include.
        text: truncateAtWord(summary.extract, input.max_chars),
        sections: outline,
        ...(input.include_references ? { references: document.references } : {}),
        notice:
          `'${resolvedTitle}' is ${summary.extract.length} characters, over the ${input.max_chars} budget, so only the ` +
          `opening text is shown. Call this tool again with \`section\` set to one or more of the \`index\` values above ` +
          `(an array reads several in a single request); each entry's \`chars\` is what that read will return.`,
      });
    }

    if (summary.extract.length === 0) {
      // TextExtracts documents that an article which does not begin with a lead paragraph — one
      // opening with a template, or an unclosed/empty element — yields an empty extract. Rendering
      // the page ourselves is the fallback rather than returning nothing.
      const document = await cachedDocument(env, host, resolvedTitle);
      const text = document.sections.map((section) => section.text).join("\n\n").trim();
      return jsonResult({
        ...base,
        section: null,
        section_title: null,
        outline_only: false,
        text: truncateAtWord(text, input.max_chars),
        notice: text.length === 0 ? `'${resolvedTitle}' rendered as empty. It may be a redirect or contain only templates.` : "",
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

/** Accept one index or several, de-duplicated but in the order the caller asked for. */
function normaliseSections(section: string | string[]): string[] {
  const list = Array.isArray(section) ? section : [section];
  return [...new Set(list.map((index) => index.trim()).filter((index) => index.length > 0))];
}

/**
 * Cut to a budget without splitting a word.
 *
 * A bare `slice` produced things like "full statutory independe", which reads as a fact about the
 * article rather than an artefact of truncation. Falls back to the hard cut when the budget lands
 * inside a single enormous token.
 */
export function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  const trimmed = lastBreak > maxChars * 0.8 ? cut.slice(0, lastBreak) : cut;
  return `${trimmed.trimEnd()}…`;
}

function cachedDocument(env: Env, host: string, title: string): Promise<ParsedDocument & { title: string }> {
  // The parsed structure is cached, not the 100 KB - 1 MB of HTML it came from: the derived text is
  // an order of magnitude smaller and is what every caller actually wants.
  return cached(env.MCP_CACHE, `wikimedia:document:${host}:${title}`, CACHE_TTL.SLOW_MOVING, () => fetchPageDocument(env, host, title));
}
