import { afterEach, describe, expect, it, vi } from "vitest";
import { openlibrarySearchHandler } from "../src/tools/openlibrarySearch.js";
import { fakeEnv } from "./support/fakeEnv.js";

describe("ia_openlibrary_search", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces the ia[] identifiers that bridge into ia_get_item / ia_search_inside_text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            numFound: 1,
            docs: [
              {
                key: "/works/OL1234W",
                title: "The Hobbit",
                author_name: ["J.R.R. Tolkien"],
                first_publish_year: 1937,
                edition_count: 120,
                ia: ["hobbitortherebac00tolk_2", "hobbit0000tolk"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await openlibrarySearchHandler({ query: "the hobbit tolkien" }, fakeEnv());

    expect(result.structuredContent?.items).toEqual([
      {
        title: "The Hobbit",
        author_name: ["J.R.R. Tolkien"],
        first_publish_year: 1937,
        edition_count: 120,
        archive_org_identifiers: ["hobbitortherebac00tolk_2", "hobbit0000tolk"],
      },
    ]);
  });

  it("returns an empty identifiers array (not undefined) when a book has no scanned edition", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ numFound: 1, docs: [{ key: "/works/OL2W", title: "Some Book" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await openlibrarySearchHandler({ query: "some book" }, fakeEnv());

    expect((result.structuredContent?.items as Array<{ archive_org_identifiers: string[] }>)[0]?.archive_org_identifiers).toEqual([]);
  });
});
