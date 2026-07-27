import { UpstreamHttpError } from "@iolab/mcp-kit";
import { actionApiUrl } from "../projects.js";
import { wikimediaFetch } from "./http.js";

export const SOURCE = "Wikimedia";

/**
 * The Action API reports its own failures as HTTP **200** with an `error` object in the body —
 * confirmed live: paging past the CirrusSearch ceiling returns 200 with
 * `{"error":{"code":"cirrussearch-offset-too-large",...}}`. `UpstreamHttpError` therefore only
 * catches transport-level failures; every body-level failure surfaces as this instead, so tool
 * handlers can turn a known `code` into an actionable message.
 */
export class ActionApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly info: string,
  ) {
    super(`${SOURCE} API error ${code}: ${info}`);
    this.name = "ActionApiError";
  }
}

/** A page the caller asked for that the wiki does not have. Action API marks these `missing: true`. */
export class PageNotFoundError extends Error {
  constructor(public readonly title: string) {
    super(`No page titled '${title}' exists on this wiki.`);
    this.name = "PageNotFoundError";
  }
}

type ActionApiResponse = {
  error?: { code?: string; info?: string };
  warnings?: Record<string, { warnings?: string }>;
  continue?: Record<string, string | number>;
  batchcomplete?: boolean;
  query?: unknown;
  parse?: unknown;
};

/**
 * Issue one Action API request.
 *
 * `format=json` and `formatversion=2` are forced on every call and cannot be overridden by
 * `params`: formatversion 1 returns `*`-keyed content, `\uXXXX`-escaped text, pageid-keyed objects
 * instead of arrays, and empty-string flags instead of booleans. Every response type in this
 * server is written against version 2.
 */
export async function actionApi<T = unknown>(
  env: Env,
  host: string,
  params: Record<string, string | number | undefined>,
): Promise<T & ActionApiResponse> {
  const url = actionApiUrl(host);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");

  const response = await wikimediaFetch(env, url);
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const body = (await response.json()) as T & ActionApiResponse;
  if (body.error) {
    throw new ActionApiError(body.error.code ?? "unknown", body.error.info ?? "No further detail supplied.");
  }
  return body;
}

/** A `query.pages[]` entry, with the markers the Action API uses instead of HTTP status codes. */
export type QueryPage = {
  pageid?: number;
  ns?: number;
  title: string;
  missing?: boolean;
  invalid?: boolean;
  invalidreason?: string;
};

export type TitleResolution = {
  /** The title the caller supplied, if the API rewrote whitespace/capitalisation to reach the real one. */
  normalized_from: string | null;
  /** The title that redirected to the resolved page, if any. Distinct from normalisation. */
  redirected_from: string | null;
};

type QueryEnvelope = {
  query?: {
    normalized?: Array<{ from: string; to: string }>;
    redirects?: Array<{ from: string; to: string }>;
    pages?: QueryPage[];
  };
};

/**
 * Report how a requested title was rewritten before the wiki resolved it.
 *
 * Normalisation and redirection are two separate steps and the API reports them in two separate
 * arrays — confirmed live, `kiwi bird` is *normalised* to `Kiwi bird` and then *redirected* to
 * `Kiwi (bird)`. Collapsing them into one "we changed your title" fact loses the distinction
 * between a typo-ish fixup and an editorial redirect, so both are surfaced.
 */
export function resolveTitle(body: QueryEnvelope, requested: string): TitleResolution {
  const normalized = body.query?.normalized?.find((entry) => entry.from === requested);
  const redirectSource = normalized?.to ?? requested;
  const redirect = body.query?.redirects?.find((entry) => entry.from === redirectSource);
  return {
    normalized_from: normalized ? normalized.from : null,
    redirected_from: redirect ? redirect.from : null,
  };
}

/** Pull the single page out of a one-title query, converting the API's markers into real errors. */
export function requireSinglePage(body: QueryEnvelope, requested: string): QueryPage {
  const page = body.query?.pages?.[0];
  if (!page) throw new PageNotFoundError(requested);
  if (page.invalid) {
    throw new ActionApiError("invalidtitle", page.invalidreason ?? `'${requested}' is not a valid page title.`);
  }
  if (page.missing) throw new PageNotFoundError(page.title ?? requested);
  return page;
}

/**
 * Read the continuation token for a list module out of a response.
 *
 * Only `list=search` is offset-paginated; every other list module returns an opaque cursor whose
 * key is module-specific (`blcontinue`, `cmcontinue`, `clcontinue`, ...). Tools surface it verbatim
 * as `next_cursor` rather than pretending it is an offset — walking pages internally to synthesise
 * one would cost O(offset/limit) upstream requests against an API limited to one at a time.
 */
export function readCursor(body: ActionApiResponse, key: string): string | null {
  const value = body.continue?.[key];
  return value === undefined ? null : String(value);
}
