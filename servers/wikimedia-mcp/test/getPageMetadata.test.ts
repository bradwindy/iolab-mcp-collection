import { afterEach, describe, expect, it, vi } from "vitest";
import { getPageMetadataHandler } from "../src/tools/getPageMetadata.js";
import { calledUrls, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const anyUrl = () => true;

const kiwiPage = {
  pageid: 17362,
  ns: 0,
  title: "Kiwi (bird)",
  description: "Order of birds",
  descriptionsource: "local",
  canonicalurl: "https://en.wikipedia.org/wiki/Kiwi_(bird)",
  length: 67915,
  touched: "2026-07-26T17:31:49Z",
  pageprops: { wikibase_item: "Q43642" },
  thumbnail: { source: "https://upload.wikimedia.org/thumb/500px-TeTuatahianui.jpg", width: 400, height: 533 },
  original: { source: "https://upload.wikimedia.org/TeTuatahianui.jpg", width: 994, height: 1325 },
  coordinates: [{ lat: -41.2, lon: 174.8, primary: true, globe: "earth" }],
  langlinks: [{ lang: "fr", url: "https://fr.wikipedia.org/wiki/Kiwi_(oiseau)", langname: "French", autonym: "français", title: "Kiwi (oiseau)" }],
};

describe("wikimedia_get_page_metadata", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("flattens the metadata a caller needs without returning the article text", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [kiwiPage] } } }]);

    const result = await getPageMetadataHandler({ titles: ["Kiwi (bird)"] }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.pages).toEqual([
      {
        index: 0,
        requested_title: "Kiwi (bird)",
        title: "Kiwi (bird)",
        pageid: 17362,
        exists: true,
        maintenance: { flags: [], is_stub: false },
        description: "Order of birds",
        description_source: "local",
        url: "https://en.wikipedia.org/wiki/Kiwi_(bird)",
        length_bytes: 67915,
        last_edited: "2026-07-26T17:31:49Z",
        wikibase_item: "Q43642",
        is_disambiguation: false,
        thumbnail_url: "https://upload.wikimedia.org/thumb/500px-TeTuatahianui.jpg",
        image_url: "https://upload.wikimedia.org/TeTuatahianui.jpg",
        coordinates: { lat: -41.2, lon: 174.8 },
      },
    ]);
  });

  it("omits language links unless asked, and includes them when asked", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [kiwiPage] } } }]);
    const withoutLangs = await getPageMetadataHandler({ titles: ["Kiwi (bird)"] }, fakeEnv());
    expect((withoutLangs.structuredContent?.pages as Array<Record<string, unknown>>)[0]?.["languages"]).toBeUndefined();

    vi.unstubAllGlobals();
    stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [kiwiPage] } } }]);
    const withLangs = await getPageMetadataHandler({ titles: ["Kiwi (bird)"], include_languages: true }, fakeEnv());
    expect((withLangs.structuredContent?.pages as Array<Record<string, unknown>>)[0]?.["languages"]).toEqual([
      { lang: "fr", title: "Kiwi (oiseau)", name: "French", url: "https://fr.wikipedia.org/wiki/Kiwi_(oiseau)" },
    ]);
  });

  it("reports a missing page as exists:false rather than failing the whole batch", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          batchcomplete: true,
          query: {
            normalized: [{ fromencoded: false, from: "kiwi bird", to: "Kiwi bird" }],
            redirects: [{ from: "Kiwi bird", to: "Kiwi (bird)" }],
            pages: [{ ns: 0, title: "Nope12345", missing: true }, kiwiPage],
          },
        },
      },
    ]);

    const result = await getPageMetadataHandler({ titles: ["kiwi bird", "Nope12345"] }, fakeEnv());

    expect(result.isError).toBeUndefined();
    const pages = result.structuredContent?.pages as Array<{ title: string; exists: boolean }>;
    expect(pages.find((page) => page.title === "Nope12345")?.exists).toBe(false);
    expect(pages.find((page) => page.title === "Kiwi (bird)")?.exists).toBe(true);
    expect(result.structuredContent?.notice).toContain("Nope12345");
    expect(result.structuredContent?.normalized).toEqual([{ fromencoded: false, from: "kiwi bird", to: "Kiwi bird" }]);
    expect(result.structuredContent?.redirected).toEqual([{ from: "Kiwi bird", to: "Kiwi (bird)" }]);
  });

  it("flags a disambiguation page by key presence, not by the empty-string value", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: { batchcomplete: true, query: { pages: [{ ns: 0, pageid: 1, title: "Kiwi", pageprops: { disambiguation: "" } }] } },
      },
    ]);

    const result = await getPageMetadataHandler({ titles: ["Kiwi"] }, fakeEnv());

    expect((result.structuredContent?.pages as Array<{ is_disambiguation: boolean }>)[0]?.is_disambiguation).toBe(true);
  });

  it("de-duplicates titles before sending them, since the API caps a batch at 50", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [kiwiPage] } } }]);

    await getPageMetadataHandler({ titles: ["Kiwi (bird)", "Kiwi (bird)", " ", "Kiwifruit"] }, fakeEnv());

    expect((calledUrls(mock)[0] as URL).searchParams.get("titles")).toBe("Kiwi (bird)|Kiwifruit");
  });

  it("rejects a batch of more than 50 titles at the schema, before the API errors", async () => {
    // 51 titles gets `toomanyvalues` from the API; failing in the schema gives a better message.
    const result = await getPageMetadataHandler({ titles: Array.from({ length: 51 }, (_, index) => `Page ${index}`) }, fakeEnv()).catch(
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(Error);
  });

  it("rejects a batch that is empty once blanks are removed", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [] } } }]);

    const result = await getPageMetadataHandler({ titles: ["   "] }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });

  it("sends palimit=max, which is per batch rather than per page", async () => {
    // Verified live: at the default of 10 — counted across every page in the batch, not per page —
    // three titles returned assessments for one and silently nothing for the other two.
    const mock = stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [kiwiPage] } } }]);

    await getPageMetadataHandler({ titles: ["Kiwi (bird)"] }, fakeEnv());

    const url = calledUrls(mock)[0] as URL;
    expect(url.searchParams.get("palimit")).toBe("max");
    expect(url.searchParams.get("prop")).toContain("pageassessments");
    expect(url.searchParams.get("clshow")).toBe("hidden");
  });

  it("returns rows in the order asked for, with an index and the requested title", async () => {
    // MediaWiki does not answer in submission order, and each row carries only the resolved title —
    // so a caller reading pages[0] could previously get the answer to titles[1].
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          batchcomplete: true,
          query: {
            normalized: [{ from: "kiwi bird", to: "Kiwi bird" }],
            redirects: [{ from: "Kiwi bird", to: "Kiwi (bird)" }],
            pages: [
              { pageid: 1, ns: 0, title: "Kākāpō" },
              { ...kiwiPage },
            ],
          },
        },
      },
    ]);

    const result = await getPageMetadataHandler({ titles: ["kiwi bird", "Kākāpō"] }, fakeEnv());

    const pages = result.structuredContent?.pages as Array<Record<string, unknown>>;
    expect(pages.map((page) => page["requested_title"])).toEqual(["kiwi bird", "Kākāpō"]);
    expect(pages.map((page) => page["index"])).toEqual([0, 1]);
    // Followed through both hops: normalisation and then the redirect.
    expect(pages[0]?.["title"]).toBe("Kiwi (bird)");
    expect(pages[1]?.["title"]).toBe("Kākāpō");
  });

  it("summarises assessments and maintenance categories into quality signals", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          batchcomplete: true,
          query: {
            pages: [
              {
                ...kiwiPage,
                // Live shape: an object keyed by WikiProject name. WP:PIQA's pseudo-project is the
                // one that carries a single grade for the whole article.
                pageassessments: {
                  Birds: { class: "B", importance: "High" },
                  "New Zealand": { class: "C", importance: "Mid" },
                  "Project-independent assessment": { class: "C", importance: "" },
                },
                categories: [
                  { title: "Category:All articles with unsourced statements", hidden: true },
                  { title: "Category:Articles with unsourced statements from June 2026", hidden: true },
                  { title: "Category:Articles with unsourced statements from July 2026", hidden: true },
                  // A hidden `All ` category that is NOT a maintenance issue — 38k articles carry it,
                  // which is why the allow-list is explicit rather than a prefix match.
                  { title: "Category:All Wikipedia articles written in New Zealand English", hidden: true },
                  { title: "Category:Birds of New Zealand", hidden: false },
                ],
                protection: [{ type: "edit", level: "extendedconfirmed", expiry: "infinity" }],
                watchers: 110,
              },
            ],
          },
        },
      },
    ]);

    const result = await getPageMetadataHandler({ titles: ["Kiwi (bird)"] }, fakeEnv());

    const page = (result.structuredContent?.pages as Array<Record<string, unknown>>)[0];
    expect(page?.["assessment_class"]).toBe("C");
    expect(page?.["maintenance"]).toEqual({
      flags: ["unsourced_statements"],
      is_stub: false,
      oldest_tag_month: "2026-06",
    });
    expect(page?.["protection"]).toEqual([{ type: "edit", level: "extendedconfirmed", expiry: "infinity" }]);
    expect(page?.["watchers"]).toBe(110);
  });

  it("omits watchers entirely rather than reporting a suppressed count as zero", async () => {
    // MediaWiki hides the count below 30 watchers so an unwatched page cannot be identified.
    stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [kiwiPage] } } }]);

    const result = await getPageMetadataHandler({ titles: ["Kiwi (bird)"] }, fakeEnv());

    expect((result.structuredContent?.pages as Array<Record<string, unknown>>)[0]?.["watchers"]).toBeUndefined();
  });
});
