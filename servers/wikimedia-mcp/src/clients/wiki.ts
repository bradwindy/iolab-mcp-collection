import { parsePageDocument, stripInlineHtml, type ParsedDocument } from "../html.js";
import { foldDiacritics } from "../text.js";
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
  /** CirrusSearch's own "did you mean", when it offers one. Advisory only — see searchPages.ts. */
  suggestion?: string;
  suggestion_snippet?: string;
  /** Set only when `enableRewrites` was passed: the query the service actually ran instead. */
  rewritten_query?: string;
};

/** CirrusSearch's documented ceiling for offset paging. Past it the API errors rather than truncating. */
export const SEARCH_OFFSET_CEILING = 10000;

/**
 * CirrusSearch query-builder profiles, which control how many of the query's terms a page must
 * match. This is the single most important recall lever the Action API exposes.
 *
 * The wiki default (`perfield_builder`) makes every term a `MUST`, so one absent word zeroes out an
 * otherwise perfect match. `perfield_builder_relaxed` differs by exactly one setting —
 * `minimum_should_match: '3<-1 5<50%'`, i.e. up to 3 terms all required, 4-5 terms allow one miss,
 * 6+ require half. Short queries are therefore completely unaffected.
 *
 * Confirmed live against en.wikipedia.org:
 *   "Ōpepe ambush 1869 Taupō"                     strict: 1 hit    relaxed: 10 hits, target #1
 *   "Ngāti Tūwharetoa Taupō lakebed ownership …"  strict: 0 hits   relaxed: 780 hits, target #1
 *
 * `perfield_builder_title_filter` is deliberately not offered: it adds a `3<80%` constraint on the
 * title/redirect fields and made the first query above return zero.
 */
export const QUERY_BUILDER_PROFILES = {
  relaxed: "perfield_builder_relaxed",
  all: "perfield_builder",
} as const;

export type MatchMode = keyof typeof QUERY_BUILDER_PROFILES;

export async function searchPages(
  env: Env,
  host: string,
  params: {
    search: string;
    namespace: number;
    sort: string;
    limit: number;
    offset: number;
    match: MatchMode;
    enableRewrites?: boolean;
  },
): Promise<SearchResult> {
  const body = await actionApi<{
    query?: {
      searchinfo?: { totalhits?: number; suggestion?: string; suggestionsnippet?: string; rewrittenquery?: string };
      search?: SearchHit[];
    };
  }>(env, host, {
    action: "query",
    list: "search",
    srsearch: params.search,
    srnamespace: params.namespace,
    srsort: params.sort,
    srlimit: params.limit,
    sroffset: params.offset,
    srqdprofile: QUERY_BUILDER_PROFILES[params.match],
    // The API's own default for `srinfo` is `totalhits|suggestion|rewrittenquery`. Asking for only
    // `totalhits` — as this once did — narrows it and throws away the "did you mean" for free.
    srinfo: "totalhits|suggestion|rewrittenquery",
    srprop: "snippet|size|wordcount|timestamp",
    // Opt-in, because it makes the service re-run a corrected query and return *those* rows. Useful
    // as a last resort on zero results, wrong as a default.
    ...(params.enableRewrites ? { srenablerewrites: 1 } : {}),
  });

  const info = body.query?.searchinfo;
  return {
    hits: body.query?.search ?? [],
    total_hits: info?.totalhits ?? 0,
    ...(info?.suggestion !== undefined ? { suggestion: info.suggestion } : {}),
    ...(info?.suggestionsnippet !== undefined ? { suggestion_snippet: info.suggestionsnippet } : {}),
    ...(info?.rewrittenquery !== undefined ? { rewritten_query: info.rewrittenquery } : {}),
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
 *
 * `in_title` and `in_source` are diacritic-folded on the way in, because both are emitted as quoted
 * phrases and quoted phrases search the `plain` field, whose query-side analyzer has no
 * `icu_folding` (see src/text.ts). Confirmed live: `intitle:"Ōpepe"` returns **0** hits while
 * `intitle:"Opepe"` returns 2, and `insource:"Ōpepe"` returns 4 against `insource:"Opepe"`'s 20.
 * The folded form is a strict superset — the index keeps the original alongside the folded token —
 * so this only ever adds matches. A caller who genuinely wants the exact macronised phrase can pass
 * `insource:"Ōpepe"` through `query`, which is never folded.
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

  if (input.in_title) terms.push(`intitle:${quote(foldDiacritics(input.in_title))}`);
  if (input.in_category) {
    // Not folded: a category filter is an exact name, and `incategory:"Ngāti Tūwharetoa"` must keep
    // its macrons to resolve to the real category page.
    terms.push(`${input.in_category_deep ? "deepcat" : "incategory"}:${quote(input.in_category)}`);
  }
  if (input.in_source) terms.push(`insource:${quote(foldDiacritics(input.in_source))}`);
  // `>=`, not `>`: this parameter documents itself as "on or after", and `lasteditdate:>2024-01-01`
  // excludes every edit made on 2024-01-01 itself — a silently missing day at the boundary.
  if (input.edited_after) terms.push(`lasteditdate:>=${input.edited_after}`);
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
    parse?: { tocdata?: { sections?: RawTocSection[] } };
  }>(env, host, { action: "parse", page: title, prop: "tocdata", redirects: 1 });

  return mapTocData(body.parse?.tocdata?.sections);
}

type RawTocSection = {
  index?: string;
  tocLevel?: number;
  hLevel?: number;
  number?: string;
  line?: string;
  anchor?: string;
  fromTitle?: string | false;
  codepointOffset?: number | null;
};

function mapTocData(sections: RawTocSection[] | undefined): TocSection[] {
  return (sections ?? []).map((section) => ({
    index: section.index ?? "",
    level: section.hLevel ?? section.tocLevel ?? 1,
    number: section.number ?? "",
    // `line` is the rendered heading HTML, not text — the API's own example returns "Foo &amp; Bar"
    // against an anchor of "Foo_&_Bar".
    title: stripInlineHtml(section.line ?? ""),
    anchor: section.anchor ?? "",
  }));
}


/**
 * Fetch and parse a whole page in one request: every section's plain text, its exact length, and
 * the article's citations.
 *
 * `mobileformat` runs the output through MobileFormatter, which pre-decodes numeric character
 * references. Measured on `Taupō Volcano`: `&#160;` 141 -> 0, `&#8202;` 68 -> 0, `&#91;` 86 -> 0,
 * leaving only the structural `&amp;`/`&lt;`/`&gt;`/`&quot;` that `decodeEntities` handles. **Never
 * send `mobileformat: 0`** — MediaWiki booleans are true whenever the parameter is present at all,
 * so `0` would enable it while reading as if it disabled it.
 *
 * `disablelimitreport` drops the NewPP HTML comment block, which is pure noise over the wire.
 */
export async function fetchPageDocument(env: Env, host: string, title: string): Promise<ParsedDocument & { title: string }> {
  const body = await actionApi<{
    parse?: {
      title?: string;
      text?: string;
      tocdata?: { sections?: RawTocSection[] };
    };
  }>(env, host, {
    action: "parse",
    page: title,
    prop: "text|tocdata",
    redirects: 1,
    mobileformat: 1,
    disableeditsection: 1,
    disabletoc: 1,
    disablelimitreport: 1,
  });

  const outline = mapTocData(body.parse?.tocdata?.sections);
  const document = await parsePageDocument(body.parse?.text ?? "", outline);
  return { ...document, title: body.parse?.title ?? title };
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
