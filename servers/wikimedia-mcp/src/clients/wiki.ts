import { actionApi, readCursor, requireSinglePage, resolveTitle, type QueryPage, type TitleResolution } from "./actionApi.js";

export type SearchHit = {
  title: string;
  pageid: number;
  snippet: string;
  size?: number;
  wordcount?: number;
  timestamp?: string;
};

export type SearchResult = {
  hits: SearchHit[];
  total_hits: number;
};

/** CirrusSearch's documented ceiling for offset paging. Past it the API errors rather than truncating. */
export const SEARCH_OFFSET_CEILING = 10000;

export async function searchPages(
  env: Env,
  host: string,
  params: { search: string; namespace: number; sort: string; limit: number; offset: number },
): Promise<SearchResult> {
  const body = await actionApi<{
    query?: { searchinfo?: { totalhits?: number }; search?: SearchHit[] };
  }>(env, host, {
    action: "query",
    list: "search",
    srsearch: params.search,
    srnamespace: params.namespace,
    srsort: params.sort,
    srlimit: params.limit,
    sroffset: params.offset,
    srinfo: "totalhits",
    srprop: "snippet|size|wordcount|timestamp",
  });

  return {
    hits: body.query?.search ?? [],
    total_hits: body.query?.searchinfo?.totalhits ?? 0,
  };
}

/**
 * Compose CirrusSearch syntax from structured filters.
 *
 * Every other Wikipedia MCP server passes a bare query string straight through, which makes the
 * model responsible for remembering that `incategory` needs its value double-quoted when it
 * contains a space, that `deepcat` is a separate operator from `incategory`, and so on. Building
 * the syntax here means a wrong guess is impossible; the raw `query` term is still concatenated in
 * so power operators (`insource:/regex/`, `hastemplate:`, `prefer-recent:`) remain reachable.
 *
 * Double quotes are stripped from filter values rather than escaped: CirrusSearch has no documented
 * escape for a quote inside a quoted phrase, so an embedded one would silently terminate the phrase
 * and turn the remainder into unrelated search terms.
 */
export function buildSearchQuery(input: {
  query?: string | undefined;
  in_title?: string | undefined;
  in_category?: string | undefined;
  in_category_deep?: boolean | undefined;
  in_source?: string | undefined;
  more_like?: string | undefined;
  edited_after?: string | undefined;
}): string {
  const terms: string[] = [];
  const quote = (value: string) => `"${value.replace(/"/g, "")}"`;

  if (input.in_title) terms.push(`intitle:${quote(input.in_title)}`);
  if (input.in_category) {
    terms.push(`${input.in_category_deep ? "deepcat" : "incategory"}:${quote(input.in_category)}`);
  }
  if (input.in_source) terms.push(`insource:${quote(input.in_source)}`);
  if (input.edited_after) terms.push(`lasteditdate:>${input.edited_after}`);
  // `morelike:` is the documented replacement for the removed RESTBase /page/related endpoint. It
  // must not be quoted — the operator takes a bare page title, spaces and all.
  if (input.more_like) terms.push(`morelike:${input.more_like}`);
  if (input.query) terms.push(input.query);

  return terms.join(" ").trim();
}

export type PageSummary = {
  page: QueryPage;
  resolution: TitleResolution;
  extract: string;
  description?: string;
  is_disambiguation: boolean;
  wikibase_item?: string;
  canonical_url?: string;
};

/** Fetch a page's plain-text extract plus the metadata needed to describe and classify it. */
export async function fetchPageExtract(
  env: Env,
  host: string,
  params: { title: string; introOnly: boolean },
): Promise<PageSummary> {
  const body = await actionApi<{
    query?: { pages?: Array<QueryPage & { extract?: string; description?: string; pageprops?: Record<string, string>; canonicalurl?: string }> };
  }>(env, host, {
    action: "query",
    prop: "extracts|description|pageprops|info",
    inprop: "url",
    ppprop: "disambiguation|wikibase_item",
    explaintext: 1,
    // `exintro` is the only mode that supports batching; this server reads one title at a time, but
    // passing exlimit=1 explicitly documents that a full-article extract silently degrades to one
    // result anyway (confirmed live: extra titles come back with an empty extract and a warning).
    exlimit: 1,
    ...(params.introOnly ? { exintro: 1 } : {}),
    titles: params.title,
    redirects: 1,
  });

  const page = requireSinglePage(body, params.title);
  const full = page as QueryPage & { extract?: string; description?: string; pageprops?: Record<string, string>; canonicalurl?: string };
  return {
    page,
    resolution: resolveTitle(body, params.title),
    extract: full.extract ?? "",
    ...(full.description !== undefined ? { description: full.description } : {}),
    // The marker is an empty string in BOTH format versions — test for key presence, never truthiness.
    is_disambiguation: full.pageprops !== undefined && "disambiguation" in full.pageprops,
    ...(full.pageprops?.["wikibase_item"] !== undefined ? { wikibase_item: full.pageprops["wikibase_item"] } : {}),
    ...(full.canonicalurl !== undefined ? { canonical_url: full.canonicalurl } : {}),
  };
}

export type TocSection = {
  index: string;
  level: number;
  number: string;
  title: string;
  anchor: string;
};

/**
 * Fetch a page's section outline.
 *
 * Uses `prop=tocdata`, NOT `prop=sections`: the latter is deprecated and the live API says so
 * ("prop=sections has been deprecated. Please use prop=tocdata instead."). `tocdata` carries the
 * same information under camelCase keys — `tocLevel`/`hLevel`/`fromTitle`/`codepointOffset` — and
 * still exposes the `index` that `&section=N` consumes.
 */
export async function fetchSectionOutline(env: Env, host: string, title: string): Promise<TocSection[]> {
  const body = await actionApi<{
    parse?: {
      tocdata?: { sections?: Array<{ index?: string; tocLevel?: number; hLevel?: number; number?: string; line?: string; anchor?: string }> };
    };
  }>(env, host, { action: "parse", page: title, prop: "tocdata", redirects: 1 });

  return (body.parse?.tocdata?.sections ?? []).map((section) => ({
    index: section.index ?? "",
    level: section.hLevel ?? section.tocLevel ?? 1,
    number: section.number ?? "",
    title: section.line ?? "",
    anchor: section.anchor ?? "",
  }));
}

/** Fetch one section of a page as rendered HTML, ready for htmlToPlainText. */
export async function fetchSectionHtml(env: Env, host: string, title: string, section: string): Promise<{ html: string; title: string }> {
  const body = await actionApi<{ parse?: { title?: string; text?: string } }>(env, host, {
    action: "parse",
    page: title,
    section,
    prop: "text",
    redirects: 1,
  });
  return { html: body.parse?.text ?? "", title: body.parse?.title ?? title };
}

/** Fetch the mainspace links on a page — used to list a disambiguation page's options. */
export async function fetchPageLinks(env: Env, host: string, title: string): Promise<string[]> {
  const body = await actionApi<{ parse?: { links?: Array<{ ns: number; title: string; exists?: boolean }> } }>(env, host, {
    action: "parse",
    page: title,
    prop: "links",
    redirects: 1,
  });
  return (body.parse?.links ?? []).filter((link) => link.ns === 0 && link.exists).map((link) => link.title);
}

export type PageMetadata = QueryPage & {
  description?: string;
  descriptionsource?: string;
  canonicalurl?: string;
  fullurl?: string;
  length?: number;
  touched?: string;
  lastrevid?: number;
  pageprops?: Record<string, string>;
  thumbnail?: { source: string; width: number; height: number };
  original?: { source: string; width: number; height: number };
  coordinates?: Array<{ lat: number; lon: number; primary?: boolean; globe?: string }>;
  langlinks?: Array<{ lang: string; url?: string; langname?: string; autonym?: string; title: string }>;
};

export async function fetchPageMetadata(
  env: Env,
  host: string,
  params: { titles: string[]; thumbnailWidth: number },
): Promise<{ pages: PageMetadata[]; normalized: Array<{ from: string; to: string }>; redirects: Array<{ from: string; to: string }> }> {
  const body = await actionApi<{
    query?: {
      pages?: PageMetadata[];
      normalized?: Array<{ from: string; to: string }>;
      redirects?: Array<{ from: string; to: string }>;
    };
  }>(env, host, {
    action: "query",
    prop: "info|description|pageimages|coordinates|pageprops|langlinks",
    inprop: "url",
    ppprop: "disambiguation|wikibase_item",
    piprop: "thumbnail|original",
    pithumbsize: params.thumbnailWidth,
    lllimit: 500,
    llprop: "url|langname|autonym",
    titles: params.titles.join("|"),
    redirects: 1,
  });

  return {
    pages: body.query?.pages ?? [],
    normalized: body.query?.normalized ?? [],
    redirects: body.query?.redirects ?? [],
  };
}

export type LinkRow = { pageid?: number; ns: number; title: string };

const BACKLINK_MODULES = {
  links_here: { list: "backlinks", titleParam: "bltitle", limitParam: "bllimit", nsParam: "blnamespace", cursorKey: "blcontinue" },
  transclusions: { list: "embeddedin", titleParam: "eititle", limitParam: "eilimit", nsParam: "einamespace", cursorKey: "eicontinue" },
  file_usage: { list: "imageusage", titleParam: "iutitle", limitParam: "iulimit", nsParam: "iunamespace", cursorKey: "iucontinue" },
} as const;

export type BacklinkType = keyof typeof BACKLINK_MODULES;

export async function fetchBacklinks(
  env: Env,
  host: string,
  params: { title: string; type: BacklinkType; namespace?: number | undefined; limit: number; cursor?: string | undefined },
): Promise<{ rows: LinkRow[]; next_cursor: string | null }> {
  const module = BACKLINK_MODULES[params.type];
  const body = await actionApi<{ query?: Record<string, LinkRow[]> }>(env, host, {
    action: "query",
    list: module.list,
    [module.titleParam]: params.title,
    [module.limitParam]: params.limit,
    ...(params.namespace !== undefined ? { [module.nsParam]: params.namespace } : {}),
    ...(params.cursor ? { [module.cursorKey]: params.cursor } : {}),
  });

  return {
    rows: body.query?.[module.list] ?? [],
    next_cursor: readCursor(body, module.cursorKey),
  };
}

export type CategoryRow = { ns: number; title: string; hidden?: boolean; sortkeyprefix?: string };

/**
 * The most categories the Action API will return per request.
 *
 * `clshow=!hidden` is deliberately NOT used, despite being the obvious way to drop maintenance
 * categories. Confirmed live on `Kiwi (bird)` (28 categories, 19 of them hidden): the filter is
 * applied *after* the `cllimit` window is chosen and the response carries no `continue`, so
 * `cllimit=3` returns zero categories and `cllimit=10` returns one — while reporting, in both
 * cases, that there is nothing more to fetch. A paginating client silently loses most of the real
 * categories. Fetching the full 500 with `clprop=hidden` and filtering here is correct instead.
 */
export const CATEGORY_FETCH_LIMIT = 500;

export async function fetchPageCategories(
  env: Env,
  host: string,
  title: string,
): Promise<{ rows: CategoryRow[]; truncated: boolean; resolvedTitle: string; resolution: TitleResolution }> {
  const body = await actionApi<{ query?: { pages?: Array<QueryPage & { categories?: CategoryRow[] }> } }>(env, host, {
    action: "query",
    prop: "categories",
    titles: title,
    cllimit: CATEGORY_FETCH_LIMIT,
    clprop: "hidden|sortkey",
    redirects: 1,
  });

  const page = requireSinglePage(body, title) as QueryPage & { categories?: CategoryRow[] };
  return {
    rows: page.categories ?? [],
    truncated: readCursor(body, "clcontinue") !== null,
    // `redirects: 1` above means the categories can belong to a different page than the one asked
    // for; reporting the requested title would attribute them to the wrong article.
    resolvedTitle: page.title,
    resolution: resolveTitle(body, title),
  };
}

export type CategoryMember = { pageid?: number; ns: number; title: string; type?: string; timestamp?: string };

export async function fetchCategoryMembers(
  env: Env,
  host: string,
  params: { category: string; type: string; namespace?: number | undefined; limit: number; cursor?: string | undefined },
): Promise<{ rows: CategoryMember[]; next_cursor: string | null }> {
  const body = await actionApi<{ query?: { categorymembers?: CategoryMember[] } }>(env, host, {
    action: "query",
    list: "categorymembers",
    cmtitle: params.category,
    cmtype: params.type,
    cmlimit: params.limit,
    cmprop: "ids|title|type|timestamp",
    // Sort key order is the API's default and is deterministic, which is what makes the opaque
    // cursor safe to hand back to the caller across calls.
    cmsort: "sortkey",
    ...(params.namespace !== undefined ? { cmnamespace: params.namespace } : {}),
    ...(params.cursor ? { cmcontinue: params.cursor } : {}),
  });

  return {
    rows: body.query?.categorymembers ?? [],
    next_cursor: readCursor(body, "cmcontinue"),
  };
}
