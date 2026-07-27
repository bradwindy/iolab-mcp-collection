import { z } from "zod";
import { CACHE_TTL, cached, jsonResult, toolError, type ToolTextResult } from "@iolab/mcp-kit";
import { cacheKey } from "../cacheKeys.js";
import { fetchPageMetadata } from "../clients/wiki.js";
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
      title: z.string(),
      pageid: z.number().optional(),
      exists: z.boolean(),
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

    const rows = pages.map((page) => {
      // `missing`/`invalid` are per-page markers, not HTTP failures — a batch legitimately mixes
      // real and nonexistent pages, so these are reported as `exists: false` rather than thrown.
      const exists = page.missing !== true && page.invalid !== true;
      const primaryCoord = page.coordinates?.find((coord) => coord.primary) ?? page.coordinates?.[0];
      return {
        title: page.title,
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
