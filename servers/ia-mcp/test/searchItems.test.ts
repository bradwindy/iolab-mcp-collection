import { afterEach, describe, expect, it, vi } from "vitest";
import { searchItemsHandler } from "../src/tools/searchItems.js";
import { fakeEnv } from "./support/fakeEnv.js";

function advancedSearchResponse(numFound: number, docs: unknown[]) {
  return new Response(JSON.stringify({ response: { numFound, docs } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ia_search_items", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses advancedsearch.php with an explicit sort, never the Scrape API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(advancedSearchResponse(1, [{ identifier: "nasa" }]));
    vi.stubGlobal("fetch", fetchMock);

    await searchItemsHandler({ query: "moon" }, fakeEnv());

    const requestedUrl = new URL((fetchMock.mock.calls[0]?.[0] as Request | string | URL).toString());
    expect(requestedUrl.pathname).toBe("/advancedsearch.php");
    expect(requestedUrl.searchParams.get("sort[]")).toBe("identifier asc");
  });

  it("builds details_url from the identifier", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(advancedSearchResponse(1, [{ identifier: "nasa", title: "NASA Images" }])));

    const result = await searchItemsHandler({ query: "nasa" }, fakeEnv());

    expect(result.structuredContent?.items).toEqual([
      { identifier: "nasa", title: "NASA Images", details_url: "https://archive.org/details/nasa" },
    ]);
  });

  it("drops fav-* pseudo-collections from search results — confirmed live a popular item can carry 1000+ of them", async () => {
    const collection = ["movies", ...Array.from({ length: 50 }, (_, i) => `fav-user${i}`)];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(advancedSearchResponse(1, [{ identifier: "nasa", collection }])),
    );

    const result = await searchItemsHandler({ query: "nasa" }, fakeEnv());

    const items = result.structuredContent?.items as Array<{ collection?: string[] }>;
    expect(items[0]?.collection).toEqual(["movies"]);
  });

  it("rejects an offset that isn't a multiple of limit with an actionable error, not a silent wrong page", async () => {
    const result = await searchItemsHandler({ query: "moon", limit: 20, offset: 7 }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("multiple of");
  });

  it("surfaces the deep-pagination limit as an actionable error rather than an opaque failure", async () => {
    const result = await searchItemsHandler({ query: "moon", limit: 100, offset: 10000 }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("10,000");
  });
});
