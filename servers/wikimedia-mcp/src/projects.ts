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
] as const;

export type Project = (typeof PROJECTS)[number];

export const projectParam = z
  .enum(PROJECTS)
  .default("wikipedia")
  .describe(
    "Which Wikimedia project to read: 'wikipedia' (encyclopedia), 'wiktionary' (dictionary definitions), " +
      "'wikisource' (source texts), 'wikiquote' (quotations), 'wikivoyage' (travel guides), 'wikinews', " +
      "or 'wikispecies' (taxonomy — note it has no per-language edition, so `lang` is ignored for it).",
  );

export const langParam = z
  .string()
  .regex(/^[a-z]{2,3}(-[a-z0-9-]+)?$/i, "Use a wiki language code like 'en', 'mi', 'fr', or 'zh-yue'.")
  .default("en")
  .describe("Wiki language edition code, e.g. 'en', 'mi' (te reo Maori), 'fr'. Ignored for project 'wikispecies'.");

/** Wikimedia Commons is not in the `project` enum — it has its own dedicated tools and no language editions. */
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
  return `${lang.toLowerCase()}.${project}.org`;
}

/** The Action API endpoint for a wiki host. */
export function actionApiUrl(host: string): URL {
  return new URL(`https://${host}/w/api.php`);
}
