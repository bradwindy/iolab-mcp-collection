import { afterEach, describe, expect, it, vi } from "vitest";
import { getCategoryMembersHandler } from "../src/tools/getCategoryMembers.js";
import { calledUrls, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const anyUrl = () => true;

// Confirmed live: cmcontinue is an opaque hex sortkey blob, deterministic but not an offset.
const LIVE_CURSOR = "page|0c530306403a4e50044634042c3a4c304e0446340450463e32402a52011e01c4dcb6dc0a|10984813";

describe("wikimedia_get_category_members", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists a category's members and passes the opaque cursor through verbatim", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          batchcomplete: true,
          continue: { cmcontinue: LIVE_CURSOR, continue: "-||" },
          query: {
            categorymembers: [
              { pageid: 206928, ns: 0, title: "List of birds of New Zealand", type: "page", timestamp: "2025-06-26T12:24:07Z" },
            ],
          },
        },
      },
    ]);

    const result = await getCategoryMembersHandler({ category: "Birds of New Zealand" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.members).toEqual([
      { title: "List of birds of New Zealand", pageid: 206928, namespace: 0, type: "page", added: "2025-06-26T12:24:07Z" },
    ]);
    expect(result.structuredContent?.next_cursor).toBe(LIVE_CURSOR);
  });

  it("adds the Category: prefix the API requires, and leaves an existing one alone", async () => {
    for (const [input, expected] of [
      ["Birds of New Zealand", "Category:Birds of New Zealand"],
      ["Category:Birds of New Zealand", "Category:Birds of New Zealand"],
      ["category:Birds of New Zealand", "category:Birds of New Zealand"],
      // Localised namespace aliases: frwiki calls namespace 14 "Catégorie", dewiki "Kategorie".
      // Matching only the English prefix would produce "Category:Catégorie:Oiseaux".
      ["Catégorie:Oiseaux", "Catégorie:Oiseaux"],
      ["Kategorie:Vögel", "Kategorie:Vögel"],
    ] as const) {
      const mock = stubFetchRoutes([{ match: anyUrl, body: { query: { categorymembers: [] } } }]);
      const result = await getCategoryMembersHandler({ category: input }, fakeEnv());
      expect((calledUrls(mock)[0] as URL).searchParams.get("cmtitle")).toBe(expected);
      expect(result.structuredContent?.category).toBe(expected);
      vi.unstubAllGlobals();
    }
  });

  it("passes a deterministic sort so the opaque cursor stays valid across calls", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: { query: { categorymembers: [] } } }]);

    await getCategoryMembersHandler({ category: "Birds of New Zealand" }, fakeEnv());

    expect((calledUrls(mock)[0] as URL).searchParams.get("cmsort")).toBe("sortkey");
  });

  it("selects subcategories or files when asked", async () => {
    for (const type of ["page", "subcat", "file"] as const) {
      const mock = stubFetchRoutes([{ match: anyUrl, body: { query: { categorymembers: [] } } }]);
      await getCategoryMembersHandler({ category: "Birds of New Zealand", type }, fakeEnv());
      expect((calledUrls(mock)[0] as URL).searchParams.get("cmtype")).toBe(type);
      vi.unstubAllGlobals();
    }
  });

  it("round-trips the cursor and reports the end of the list as null", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { categorymembers: [] } } }]);

    const result = await getCategoryMembersHandler({ category: "Birds of New Zealand", cursor: LIVE_CURSOR }, fakeEnv());

    expect((calledUrls(mock)[0] as URL).searchParams.get("cmcontinue")).toBe(LIVE_CURSOR);
    expect(result.structuredContent?.next_cursor).toBeNull();
    expect(result.structuredContent?.has_more).toBe(false);
  });

  it("surfaces an unknown category as an actionable error", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { error: { code: "invalidcategory", info: "The category name you entered is not valid." } } }]);

    const result = await getCategoryMembersHandler({ category: "Not A Category" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalidcategory");
  });
});
