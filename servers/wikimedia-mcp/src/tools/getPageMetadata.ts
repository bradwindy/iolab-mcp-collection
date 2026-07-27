import { z } from "zod";
import { CACHE_TTL, cached, jsonResult, toolError, type ToolTextResult } from "@iolab/mcp-kit";
import { cacheKey } from "../cacheKeys.js";
import { fetchPageMetadata } from "../clients/wiki.js";
import { summariseAssessment, summariseMaintenance } from "../quality.js";
import { langParam, projectParam } from "../projects.js";
import { mapCommonWikiError, attributionSchema, wikiAttribution, wikiTarget } from "../toolSupport.js";

/** The Action API's own cap on `titles=`; 51 gets a `toomanyvalues` error rather than a truncation. */
const MAX_TITLES = 50;

export const getPageMetadataInputShape = {
  titles: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_TITLES)
    .describe(`One or more exact page titles (up to ${MAX_TITLES} in a single call). Redirects are resolved automatically.`),
  project: projectParam,
  lang: langParam,
  include_languages: z
    .boolean()
    .default(false)
    .describe(
      "Include the list of other language editions this page exists in, with their titles and URLs — use this to find " +
        "what an article is called in another language, then re-read it with `lang` set to that code.",
    ),
  thumbnail_width: z
    .number()
    .int()
    .min(50)
    .max(1000)
    .default(400)
    .describe("Requested thumbnail width in pixels. Wikimedia rounds to a standard bucket, so the returned image can be wider."),
};

export const getPageMetadataOutputShape = {
  pages: z.array(
    z.object({
      /** Index into the `titles` array this row answers. Rows are returned in the order asked for. */
      index: z.number(),
      /** The title as supplied, before normalisation or redirect resolution. */
      requested_title: z.string(),
      title: z.string(),
      pageid: z.number().optional(),
      exists: z.boolean(),
      /**
       * The article's quality grade: FA, FL, GA, A, B, C, Start, Stub or List. Absent when the
       * article has never been assessed.
       */
      assessment_class: z.string().optional(),
      maintenance: z
        .object({
          flags: z.array(z.string()),
          is_stub: z.boolean(),
          oldest_tag_month: z.string().optional(),
        })
        .optional(),
      /** Edit protection, if any. `extendedconfirmed`/`sysop` marks a contentious article. */
      protection: z.array(z.object({ type: z.string(), level: z.string(), expiry: z.string() })).optional(),
      /** Absent means fewer than 30 — MediaWiki suppresses the count below that. Never read as zero. */
      watchers: z.number().optional(),
      description: z.string().optional(),
      description_source: z.string().optional(),
      url: z.string().optional(),
      length_bytes: z.number().optional(),
      last_edited: z.string().optional(),
      wikibase_item: z.string().optional(),
      is_disambiguation: z.boolean(),
      thumbnail_url: z.string().optional(),
      image_url: z.string().optional(),
      coordinates: z.object({ lat: z.number(), lon: z.number() }).optional(),
      languages: z.array(z.object({ lang: z.string(), title: z.string(), name: z.string().optional(), url: z.string().optional() })).optional(),
    }),
  ),
  normalized: z.array(z.object({ from: z.string(), to: z.string() })),
  redirected: z.array(z.object({ from: z.string(), to: z.string() })),
  wiki: z.string(),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getPageMetadataInputShape);

export async function getPageMetadataHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const { host } = wikiTarget(input.project, input.lang);

  const seen = new Set<string>();
  const titles = input.titles.filter((title) => {
    const key = title.trim();
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (titles.length === 0) return toolError("No usable page titles supplied.", "Pass at least one non-empty title.");

  try {
    // Hashed: 50 titles of ordinary length blow past Workers KV's 512-byte key limit, which fails
    // the read rather than merely missing the cache. See src/cacheKeys.ts.
    const key = await cacheKey(`wikimedia:meta:${host}:${input.thumbnail_width}`, titles.join("|"));
    const { pages, normalized, redirects } = await cached(env.MCP_CACHE, key, CACHE_TTL.SLOW_MOVING, () =>
      fetchPageMetadata(env, host, { titles, thumbnailWidth: input.thumbnail_width }),
    );

    // MediaWiki does not return pages in the order they were submitted, and each row carries only
    // the *resolved* title — so `pages[i]` is not the answer to `titles[i]`, and for a normalised or
    // redirected title there was previously nothing linking a row back to what was asked for. Both
    // hops are resolved here rather than left to the caller.
    const resolved = new Map<string, string>();
    for (const step of [...normalized, ...redirects]) resolved.set(step.from, step.to);
    const finalTitle = (title: string) => {
      let current = title;
      // Normalisation and a redirect can both apply, in that order; the guard is against a cycle.
      for (let hop = 0; hop < 4; hop++) {
        const next = resolved.get(current);
        if (next === undefined) return current;
        current = next;
      }
      return current;
    };

    const byTitle = new Map(pages.map((page) => [page.title, page]));
    const ordered = titles.map((requested) => ({ requested, page: byTitle.get(finalTitle(requested)) }));

    const rows = ordered.map(({ requested, page }, index) => {
      if (page === undefined) {
        // A title the API answered under a name we could not follow. Reported rather than dropped,
        // so `pages` always lines up with `titles`.
        return { index, requested_title: requested, title: requested, exists: false, is_disambiguation: false };
      }
      // `missing`/`invalid` are per-page markers, not HTTP failures — a batch legitimately mixes
      // real and nonexistent pages, so these are reported as `exists: false` rather than thrown.
      const exists = page.missing !== true && page.invalid !== true;
      const primaryCoord = page.coordinates?.find((coord) => coord.primary) ?? page.coordinates?.[0];
      const assessment = summariseAssessment(page.pageassessments);
      return {
        index,
        requested_title: requested,
        title: page.title,
        ...(assessment !== undefined ? { assessment_class: assessment } : {}),
        ...(exists ? { maintenance: summariseMaintenance(page.categories ?? []) } : {}),
        ...(page.protection !== undefined && page.protection.length > 0 ? { protection: page.protection } : {}),
        ...(page.watchers !== undefined ? { watchers: page.watchers } : {}),
        ...(page.pageid !== undefined ? { pageid: page.pageid } : {}),
        exists,
        ...(page.description !== undefined ? { description: page.description } : {}),
        ...(page.descriptionsource !== undefined ? { description_source: page.descriptionsource } : {}),
        ...(page.canonicalurl !== undefined ? { url: page.canonicalurl } : {}),
        ...(page.length !== undefined ? { length_bytes: page.length } : {}),
        ...(page.touched !== undefined ? { last_edited: page.touched } : {}),
        ...(page.pageprops?.["wikibase_item"] !== undefined ? { wikibase_item: page.pageprops["wikibase_item"] } : {}),
        is_disambiguation: page.pageprops !== undefined && "disambiguation" in page.pageprops,
        ...(page.thumbnail?.source !== undefined ? { thumbnail_url: page.thumbnail.source } : {}),
        ...(page.original?.source !== undefined ? { image_url: page.original.source } : {}),
        ...(primaryCoord ? { coordinates: { lat: primaryCoord.lat, lon: primaryCoord.lon } } : {}),
        ...(input.include_languages && page.langlinks
          ? {
              languages: page.langlinks.map((link) => ({
                lang: link.lang,
                title: link.title,
                ...(link.langname !== undefined ? { name: link.langname } : {}),
                ...(link.url !== undefined ? { url: link.url } : {}),
              })),
            }
          : {}),
      };
    });

    const missing = rows.filter((row) => !row.exists).map((row) => row.title);

    return jsonResult({
      pages: rows,
      normalized,
      redirected: redirects,
      wiki: host,
      notice: missing.length > 0 ? `No page exists for: ${missing.join(", ")}. Use wikimedia_search_pages to find the right title.` : "",
      attribution: wikiAttribution(input.project, host),
    });
  } catch (error) {
    const mapped = mapCommonWikiError(error, "Check `project` and `lang` point at the wiki you meant.");
    if (mapped) return mapped;
    throw error;
  }
}
