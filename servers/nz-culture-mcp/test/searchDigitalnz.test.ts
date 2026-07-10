import { afterEach, describe, expect, it, vi } from "vitest";
import { searchDigitalnzHandler } from "../src/tools/searchDigitalnz.js";

const SAMPLE_RECORD = {
  id: 49676548,
  title: "small kiokio, Blechnum procerum (G.Forst.) Sw.",
  display_collection: "Te Papa Collections Online",
  display_content_partner: "Museum of New Zealand Te Papa Tongarewa",
  category: ["Images"],
  dnz_type: "Unknown",
  display_date: "Collected: 1910",
  date: ["1910-01-01T12:00:00.000Z"],
  rights: "CC BY 4.0",
  thumbnail_url: "https://media.tepapa.govt.nz/collection/758497/thumb",
  large_thumbnail_url: "https://media.tepapa.govt.nz/collection/758497/preview",
  landing_url: "https://collections.tepapa.govt.nz/object/2105890",
  description: null,
  creator: [],
  subject: [],
  tag: ["moe_tahurangi", "Kotuia"],
  usage: ["Share", "Modify", "Use commercially"],
  copyright: ["Some rights reserved"],
  language: [],
  is_commercial_use: null,
  source_url: "http://api.digitalnz.org/records/49676548/source",
};

function digitalNzResponse(results: unknown[], resultCount: number, facets: unknown = {}) {
  return new Response(
    JSON.stringify({ search: { page: 1, per_page: results.length, result_count: resultCount, results, facets } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("nz_culture_search_digitalnz", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("errors when neither query nor category is provided", async () => {
    const result = await searchDigitalnzHandler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("query");
  });

  it("errors when offset is not a multiple of limit", async () => {
    const result = await searchDigitalnzHandler({ query: "kiwi", limit: 20, offset: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("multiple of");
  });

  it("returns concise results by default and converts offset to a page number", async () => {
    const fetchMock = vi.fn().mockResolvedValue(digitalNzResponse([SAMPLE_RECORD], 317286));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchDigitalnzHandler({ query: "kiwi", limit: 10, offset: 20 });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.items).toEqual([
      {
        id: 49676548,
        title: "small kiokio, Blechnum procerum (G.Forst.) Sw.",
        category: ["Images"],
        collection: "Te Papa Collections Online",
        content_partner: "Museum of New Zealand Te Papa Tongarewa",
        date: "Collected: 1910",
        rights: "CC BY 4.0",
        thumbnail_url: "https://media.tepapa.govt.nz/collection/758497/thumb",
        landing_url: "https://collections.tepapa.govt.nz/object/2105890",
      },
    ]);
    expect(result.structuredContent?.total_count).toBe(317286);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(21);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("page")).toBe("3");
    expect(requestedUrl.searchParams.get("per_page")).toBe("10");
    expect(requestedUrl.searchParams.get("text")).toBe("kiwi");
  });

  it("includes extra fields in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(digitalNzResponse([SAMPLE_RECORD], 1)));

    const result = await searchDigitalnzHandler({ query: "kiwi", response_format: "detailed" });

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.tag).toEqual(["moe_tahurangi", "Kotuia"]);
    expect(item?.source_url).toBe("http://api.digitalnz.org/records/49676548/source");
  });

  it("filters by category via the and[category][] query param", async () => {
    const fetchMock = vi.fn().mockResolvedValue(digitalNzResponse([], 0));
    vi.stubGlobal("fetch", fetchMock);

    await searchDigitalnzHandler({ category: "Images" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("and[category][]")).toBe("Images");
  });

  it("requests facets only when include_facets is true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(digitalNzResponse([SAMPLE_RECORD], 1, { category: { Images: 5 } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchDigitalnzHandler({ query: "kiwi", include_facets: true });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("facets")).toBe("category,display_collection,display_content_partner");
    expect(result.structuredContent?.facets).toEqual({ category: { Images: 5 } });
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));

    const result = await searchDigitalnzHandler({ query: "kiwi" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DigitalNZ returned HTTP 503");
  });

  it("reports pagination truncation via the notice field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(digitalNzResponse([SAMPLE_RECORD], 500)));

    const result = await searchDigitalnzHandler({ query: "kiwi", limit: 1 });

    expect(result.structuredContent?.notice).toContain("Showing 1 of 500");
  });
});
