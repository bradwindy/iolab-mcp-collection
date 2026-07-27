import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSearchQuery } from "../src/clients/wiki.js";
import { searchPagesHandler } from "../src/tools/searchPages.js";
import { calledHeaders, calledUrls, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const anyUrl = () => true;

function searchBody(hits: unknown[], totalhits = hits.length) {
  return { batchcomplete: true, query: { searchinfo: { totalhits }, search: hits } };
}

describe("wikimedia_search_pages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("strips the searchmatch markup and HTML entities the API wraps snippets in", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: searchBody([
          {
            ns: 0,
            title: "Kiwi (bird)",
            pageid: 17362,
            // Verbatim shape of a live snippet: highlight spans plus &#039; for an apostrophe.
            snippet: '<span class="searchmatch">Kiwi</span> are New Zealand&#039;s birds',
            size: 67915,
            wordcount: 5775,
            timestamp: "2026-06-05T22:24:05Z",
          },
        ]),
      },
    ]);

    const result = await searchPagesHandler({ query: "kiwi bird" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.results).toEqual([
      {
        title: "Kiwi (bird)",
        pageid: 17362,
        snippet: "Kiwi are New Zealand's birds",
        size_bytes: 67915,
        word_count: 5775,
        last_edited: "2026-06-05T22:24:05Z",
        url: "https://en.wikipedia.org/wiki/Kiwi_(bird)",
      },
    ]);
  });

  it("keeps namespace and subpage separators unescaped in the page URL", async () => {
    // encodeURIComponent on a whole title escapes ':' and '/', which are path structure in a
    // MediaWiki URL rather than data — the result is a different page, and these titles are the
    // norm on Wikisource and Wikispecies, which this tool serves.
    stubFetchRoutes([
      { match: anyUrl, body: searchBody([{ ns: 0, title: "Author:Doyle/Chapter 1", pageid: 99, snippet: "" }]) },
    ]);

    const result = await searchPagesHandler({ query: "doyle", project: "wikisource" }, fakeEnv());

    expect((result.structuredContent?.results as Array<{ url: string }>)[0]?.url).toBe(
      "https://en.wikisource.org/wiki/Author:Doyle/Chapter_1",
    );
  });

  it("composes structured filters into CirrusSearch syntax and reports the effective query", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: searchBody([]) }]);

    const result = await searchPagesHandler(
      { in_category: "Birds of New Zealand", in_title: "kiwi", edited_after: "2025-01-01", sort: "title_natural_asc" },
      fakeEnv(),
    );

    const url = calledUrls(mock)[0] as URL;
    expect(url.searchParams.get("srsearch")).toBe('intitle:"kiwi" incategory:"Birds of New Zealand" lasteditdate:>2025-01-01');
    expect(url.searchParams.get("srsort")).toBe("title_natural_asc");
    expect(result.structuredContent?.effective_query).toBe(
      'intitle:"kiwi" incategory:"Birds of New Zealand" lasteditdate:>2025-01-01',
    );
  });

  it("always sends formatversion=2 and a policy-compliant User-Agent", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: searchBody([]) }]);

    await searchPagesHandler({ query: "kiwi" }, fakeEnv());

    // formatversion 1 would return `*`-keyed content and empty-string flags; every response type
    // in this server is written against version 2.
    expect((calledUrls(mock)[0] as URL).searchParams.get("formatversion")).toBe("2");
    // Confirmed live: a library-default User-Agent gets a flat 403 from the CDN edge, and an
    // "unidentified" client is capped at 10 req/min instead of 200.
    const userAgent = calledHeaders(mock).get("user-agent") ?? "";
    expect(userAgent).toMatch(/^iolab-mcp-collection\/wikimedia-mcp \(\+https:\/\/github\.com\//);
  });

  it("never sends an Authorization header when no OAuth token is configured", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: searchBody([]) }]);

    await searchPagesHandler({ query: "kiwi" }, fakeEnv());

    expect(calledHeaders(mock).has("authorization")).toBe(false);
  });

  it("routes to the right host per project and language, and ignores lang for wikispecies", async () => {
    for (const [input, expectedHost] of [
      [{ project: "wikipedia", lang: "mi" }, "mi.wikipedia.org"],
      [{ project: "wiktionary", lang: "fr" }, "fr.wiktionary.org"],
      [{ project: "wikisource", lang: "en" }, "en.wikisource.org"],
      // Confirmed live: en.wikispecies.org 301s away; the API is only served from this host.
      [{ project: "wikispecies", lang: "en" }, "species.wikimedia.org"],
      [{ project: "wikispecies", lang: "de" }, "species.wikimedia.org"],
    ] as const) {
      const mock = stubFetchRoutes([{ match: anyUrl, body: searchBody([]) }]);
      const result = await searchPagesHandler({ query: "kiwi", ...input }, fakeEnv());
      expect((calledUrls(mock)[0] as URL).host).toBe(expectedHost);
      expect(result.structuredContent?.wiki).toBe(expectedHost);
      vi.unstubAllGlobals();
    }
  });

  it("refuses to page past CirrusSearch's 10,000-result ceiling before calling upstream", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: searchBody([]) }]);

    const result = await searchPagesHandler({ query: "kiwi", offset: 9990, limit: 20 }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("cannot page beyond 10000");
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects a call with no search criteria rather than searching for everything", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: searchBody([]) }]);

    const result = await searchPagesHandler({}, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("`query`");
    expect(mock).not.toHaveBeenCalled();
  });

  it("turns an Action API body-level error into an actionable tool error", async () => {
    // The Action API reports its own failures as HTTP 200 with an `error` object — confirmed live
    // for the offset ceiling — so a status-only check would treat this as success.
    stubFetchRoutes([
      {
        match: anyUrl,
        body: { error: { code: "cirrussearch-offset-too-large", info: "Up to 10000 search results are supported" } },
        status: 200,
      },
    ]);

    const result = await searchPagesHandler({ query: "kiwi" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("cirrussearch-offset-too-large");
  });

  it("reports pagination from the API's own total, not the page length", async () => {
    stubFetchRoutes([{ match: anyUrl, body: searchBody([{ ns: 0, title: "A", pageid: 1, snippet: "" }], 1427) }]);

    const result = await searchPagesHandler({ query: "kiwi", limit: 1, offset: 0 }, fakeEnv());

    expect(result.structuredContent?.total_count).toBe(1427);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(1);
  });

  it("returns an empty result set without erroring", async () => {
    stubFetchRoutes([{ match: anyUrl, body: searchBody([], 0) }]);

    const result = await searchPagesHandler({ query: "zzzzznotathing" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.results).toEqual([]);
    expect(result.structuredContent?.has_more).toBe(false);
    expect(result.structuredContent?.next_offset).toBeNull();
  });
});

describe("buildSearchQuery", () => {
  it("selects deepcat instead of incategory when subcategory search is requested", () => {
    expect(buildSearchQuery({ in_category: "Birds of New Zealand", in_category_deep: true })).toBe(
      'deepcat:"Birds of New Zealand"',
    );
  });

  it("leaves more_like unquoted, since the operator takes a bare page title", () => {
    expect(buildSearchQuery({ more_like: "Kiwi (bird)" })).toBe("morelike:Kiwi (bird)");
  });

  it("strips embedded double quotes rather than letting them terminate the phrase early", () => {
    // CirrusSearch has no documented escape for a quote inside a quoted phrase, so an embedded one
    // would silently end the phrase and turn the rest into unrelated search terms.
    expect(buildSearchQuery({ in_category: 'Birds" OR incategory:"Everything' })).toBe(
      'incategory:"Birds OR incategory:Everything"',
    );
  });

  it("appends the raw query last so structured filters scope it", () => {
    expect(buildSearchQuery({ in_title: "kiwi", query: "insource:/Apteryx [a-z]+/" })).toBe(
      'intitle:"kiwi" insource:/Apteryx [a-z]+/',
    );
  });

  it("returns an empty string when nothing was supplied", () => {
    expect(buildSearchQuery({})).toBe("");
  });
});
