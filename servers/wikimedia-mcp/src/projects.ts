import { z } from "zod";

/**
 * The Wikimedia projects this server can read. All of them expose the identical MediaWiki Action
 * API at `/w/api.php` — confirmed live against every host below — so one client covers all of them
 * and adding a project costs nothing but an enum entry.
 */
export const PROJECTS = [
  "wikipedia",
  "wiktionary",
  "wikisource",
  "wikiquote",
  "wikivoyage",
  "wikinews",
  "wikispecies",
  "commons",
] as const;

export type Project = (typeof PROJECTS)[number];

export const projectParam = z
  .enum(PROJECTS)
  .default("wikipedia")
  .describe(
    "Which Wikimedia project to read: 'wikipedia' (encyclopedia), 'wiktionary' (dictionary definitions), " +
      "'wikisource' (source texts), 'wikiquote' (quotations), 'wikivoyage' (travel guides), 'wikinews', " +
      "'wikispecies' (taxonomy), or 'commons' (the shared media repository — use it to browse media " +
      "categories). Neither 'wikispecies' nor 'commons' has per-language editions, so `lang` is ignored for both.",
  );

export const langParam = z
  .string()
  .regex(/^[a-z]{2,3}(-[a-z0-9-]+)?$/i, "Use a wiki language code like 'en', 'mi', 'fr', or 'zh-yue'.")
  .default("en")
  .describe("Wiki language edition code, e.g. 'en', 'mi' (te reo Maori), 'fr'. Ignored for project 'wikispecies'.");

/**
 * Wikimedia Commons.
 *
 * Also reachable as a `project`, so category browsing works there — the dedicated media tools cover
 * files, but `wikimedia_get_category_members` had no way to reach a Commons category at all.
 */
export const COMMONS_HOST = "commons.wikimedia.org";

/** Wikidata's Action API host, used for `wbsearchentities` and the Wikibase REST API. */
export const WIKIDATA_HOST = "www.wikidata.org";

/**
 * Resolve a project + language pair to the wiki hostname serving its Action API.
 *
 * `wikispecies` is deliberately special-cased: it is served from `species.wikimedia.org` with no
 * language prefix at all. Confirmed live — `en.wikispecies.org` 301s away rather than serving the
 * API, so the naive `{lang}.{project}.org` template silently breaks for exactly this one project.
 */
export function resolveWikiHost(project: Project, lang: string): string {
  if (project === "wikispecies") return "species.wikimedia.org";
  if (project === "commons") return COMMONS_HOST;
  return `${lang.toLowerCase()}.${project}.org`;
}

/** The Action API endpoint for a wiki host. */
export function actionApiUrl(host: string): URL {
  return new URL(`https://${host}/w/api.php`);
}
