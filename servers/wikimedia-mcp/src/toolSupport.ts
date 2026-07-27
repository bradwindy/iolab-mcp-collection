import { z } from "zod";
import { attribution, toolError, UpstreamHttpError, upstreamError, type Attribution, type ToolTextResult } from "@iolab/mcp-kit";
import { ActionApiError, PageNotFoundError } from "./clients/actionApi.js";
import { resolveWikiHost, type Project } from "./projects.js";

/**
 * Turn the errors every wiki tool can hit into actionable tool-execution errors.
 *
 * Order matters and mirrors the convention used across this collection: domain errors first (most
 * specific), `UpstreamHttpError` second, and anything unrecognised rethrown rather than swallowed.
 * Returns `null` when the error isn't one of these, so callers can layer their own cases in front.
 */
export function mapCommonWikiError(error: unknown, hint: string): ToolTextResult | null {
  if (error instanceof PageNotFoundError) {
    return toolError(error.message, hint);
  }
  if (error instanceof ActionApiError) {
    return toolError(`Wikimedia rejected the request (${error.code}): ${error.info}`, hint);
  }
  if (error instanceof UpstreamHttpError) {
    // The hint must be forwarded. Omitting it fell through to `upstreamError`'s generic default,
    // "This may be transient; retry, or narrow the request if the upstream is rate-limiting" — which
    // for a deterministic failure such as a SPARQL 400 syntax error tells the model to retry a query
    // that can never succeed, while the caller's actual advice was silently discarded.
    return upstreamError(error.source, error.response, hint);
  }
  return null;
}

/**
 * Per-project content licences.
 *
 * Not one shared string: **Wikinews is CC BY 4.0, not CC BY-SA**, so a single value would misstate
 * redistribution terms for one of the seven projects in a field callers are meant to cite verbatim.
 * Each value below was read from that wiki's own `meta=siteinfo&siprop=rightsinfo`, which is the
 * authoritative source, rather than taken from any secondary claim.
 */
const PROJECT_LICENSES: Record<Project, string> = {
  wikipedia: "CC BY-SA 4.0",
  wiktionary: "CC BY-SA 4.0",
  wikisource: "CC BY-SA 4.0",
  wikiquote: "CC BY-SA 4.0",
  wikivoyage: "CC BY-SA 4.0",
  wikinews: "CC BY 4.0",
  wikispecies: "CC BY-SA 4.0",
  // Commons' own siteinfo reports CC BY-SA 4.0, which covers its wiki *text* (category and file
  // description pages). Individual media files carry their own licence — wikimedia_get_media_info
  // reports that per file, and it is the one that governs reuse of an image.
  commons: "CC BY-SA 4.0",
};

/** The source/licence note attached to every wiki response. */
export function wikiAttribution(project: Project, host: string): Attribution {
  return attribution(`${projectLabel(project)} (${host})`, {
    license: PROJECT_LICENSES[project],
    url: `https://${host}/`,
  });
}

/**
 * Build the human-facing URL for a page title.
 *
 * `encodeURIComponent` on the whole title is wrong: it escapes `/` and `:`, which are *path
 * structure* in a MediaWiki URL, not data. `Author:Doyle/Chapter 1` must become
 * `/wiki/Author:Doyle/Chapter_1`, not `/wiki/Author%3ADoyle%2FChapter_1` — a different page entirely.
 * Namespaced and subpaged titles are the norm on Wikisource and Wikispecies, which this server
 * serves, so the separators are restored after encoding.
 */
export function wikiPageUrl(host: string, title: string): string {
  const encoded = encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/gi, "/").replace(/%3A/gi, ":");
  return `https://${host}/wiki/${encoded}`;
}

const PROJECT_LABELS: Record<Project, string> = {
  wikipedia: "Wikipedia",
  wiktionary: "Wiktionary",
  wikisource: "Wikisource",
  wikiquote: "Wikiquote",
  wikivoyage: "Wikivoyage",
  wikinews: "Wikinews",
  wikispecies: "Wikispecies",
  commons: "Wikimedia Commons",
};

export function projectLabel(project: Project): string {
  return PROJECT_LABELS[project];
}

/** Resolve the wiki host and its human-readable label together, since every tool needs both. */
export function wikiTarget(project: Project, lang: string): { host: string; label: string } {
  return { host: resolveWikiHost(project, lang), label: projectLabel(project) };
}

/**
 * The `attribution` object every tool returns, declared once so no outputSchema can drift out of
 * step with what the handlers actually emit — a gap this repo's tool-design checklist calls out
 * specifically (an attribution schema forgetting an optional `license` the handler sometimes sets).
 */
export const attributionSchema = z.object({
  source: z.string(),
  license: z.string().optional(),
  url: z.string().optional(),
});
