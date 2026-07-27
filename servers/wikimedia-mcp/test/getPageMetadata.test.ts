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
        title: "Kiwi (bird)",
        pageid: 17362,
        exists: true,
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
});
