import { afterEach, describe, expect, it, vi } from "vitest";
import { getPageCategoriesHandler } from "../src/tools/getPageCategories.js";
import { calledUrls, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const anyUrl = () => true;

function categoriesBody(categories: Array<{ title: string; hidden?: boolean }>, continueToken?: string) {
  return {
    batchcomplete: true,
    ...(continueToken ? { continue: { clcontinue: continueToken, continue: "||" } } : {}),
    query: {
      pages: [
        {
          pageid: 17362,
          ns: 0,
          title: "Kiwi (bird)",
          categories: categories.map((category) => ({ ns: 14, title: category.title, ...(category.hidden ? { hidden: true } : {}) })),
        },
      ],
    },
  };
}

describe("wikimedia_get_page_categories", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hides maintenance categories by default and returns them on request", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: categoriesBody([
          { title: "Category:All articles with unsourced statements", hidden: true },
          { title: "Category:Apteryx" },
          { title: "Category:Flightless birds" },
        ]),
      },
    ]);

    const visible = await getPageCategoriesHandler({ title: "Kiwi (bird)" }, fakeEnv());
    expect(visible.structuredContent?.categories).toEqual([
      { title: "Category:Apteryx", hidden: false },
      { title: "Category:Flightless birds", hidden: false },
    ]);
    expect(visible.structuredContent?.total_count).toBe(2);

    vi.unstubAllGlobals();
    stubFetchRoutes([
      {
        match: anyUrl,
        body: categoriesBody([
          { title: "Category:All articles with unsourced statements", hidden: true },
          { title: "Category:Apteryx" },
          { title: "Category:Flightless birds" },
        ]),
      },
    ]);
    const all = await getPageCategoriesHandler({ title: "Kiwi (bird)", include_hidden: true }, fakeEnv());
    expect(all.structuredContent?.total_count).toBe(3);
  });

  it("never pushes clshow=!hidden upstream, and always requests the full 500", async () => {
    // The load-bearing regression test. Confirmed live on Kiwi (bird) — 28 categories, 19 hidden:
    // `clshow=!hidden` is applied AFTER the cllimit window and the response carries no `continue`,
    // so cllimit=3 returns zero categories and cllimit=10 returns one, both claiming completeness.
    // Fetching everything and filtering client-side is the only correct shape.
    const mock = stubFetchRoutes([{ match: anyUrl, body: categoriesBody([{ title: "Category:Apteryx" }]) }]);

    await getPageCategoriesHandler({ title: "Kiwi (bird)", limit: 3 }, fakeEnv());

    const url = calledUrls(mock)[0] as URL;
    expect(url.searchParams.has("clshow")).toBe(false);
    expect(url.searchParams.get("cllimit")).toBe("500");
    expect(url.searchParams.get("clprop")).toContain("hidden");
  });

  it("paginates the filtered list client-side so a small limit still sees every visible category", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: categoriesBody([
          { title: "Category:Hidden A", hidden: true },
          { title: "Category:Hidden B", hidden: true },
          { title: "Category:Visible A" },
          { title: "Category:Visible B" },
          { title: "Category:Visible C" },
        ]),
      },
    ]);

    const result = await getPageCategoriesHandler({ title: "Kiwi (bird)", limit: 2, offset: 0 }, fakeEnv());

    expect(result.structuredContent?.categories).toEqual([
      { title: "Category:Visible A", hidden: false },
      { title: "Category:Visible B", hidden: false },
    ]);
    expect(result.structuredContent?.total_count).toBe(3);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(2);
  });

  it("warns when a page has more categories than one request can read", async () => {
    stubFetchRoutes([{ match: anyUrl, body: categoriesBody([{ title: "Category:Apteryx" }], "17362|Something") }]);

    const result = await getPageCategoriesHandler({ title: "Kiwi (bird)" }, fakeEnv());

    expect(result.structuredContent?.notice).toContain("more than 500 categories");
  });

  it("returns an empty list for an uncategorised page", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [{ pageid: 1, ns: 0, title: "Kiwi (bird)" }] } } }]);

    const result = await getPageCategoriesHandler({ title: "Kiwi (bird)" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.categories).toEqual([]);
    expect(result.structuredContent?.total_count).toBe(0);
  });

  it("turns a missing page into an actionable error", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [{ ns: 0, title: "Nope", missing: true }] } } }]);

    const result = await getPageCategoriesHandler({ title: "Nope" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No page titled 'Nope'");
  });
});
