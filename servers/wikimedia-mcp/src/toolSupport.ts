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
    return upstreamError(error.source, error.response);
  }
  return null;
}

/** The source/licence note attached to every wiki response. */
export function wikiAttribution(project: Project, host: string): Attribution {
  return attribution(`${projectLabel(project)} (${host})`, {
    // Wikipedia and its sister projects are CC BY-SA 4.0 with text also available under GFDL; see
    // https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use. Commons and Wikidata differ and
    // carry their own attribution helpers below.
    license: "CC BY-SA 4.0",
    url: `https://${host}/`,
  });
}

const PROJECT_LABELS: Record<Project, string> = {
  wikipedia: "Wikipedia",
  wiktionary: "Wiktionary",
  wikisource: "Wikisource",
  wikiquote: "Wikiquote",
  wikivoyage: "Wikivoyage",
  wikinews: "Wikinews",
  wikispecies: "Wikispecies",
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
