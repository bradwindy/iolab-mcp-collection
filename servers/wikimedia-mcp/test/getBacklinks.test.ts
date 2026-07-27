import { afterEach, describe, expect, it, vi } from "vitest";
import { getBacklinksHandler } from "../src/tools/getBacklinks.js";
import { calledUrls, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const anyUrl = () => true;

describe("wikimedia_get_backlinks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists pages that link to a title and hands back the continuation cursor", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          batchcomplete: true,
          // Confirmed live: blcontinue is `namespace|pageid`, monotonic and stable.
          continue: { blcontinue: "0|5910", continue: "-||" },
          query: {
            backlinks: [
              { pageid: 2995, ns: 0, title: "Archaeopteryx" },
              { pageid: 3410, ns: 0, title: "Bird" },
            ],
          },
        },
      },
    ]);

    const result = await getBacklinksHandler({ title: "Kiwi (bird)" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.links).toEqual([
      { title: "Archaeopteryx", pageid: 2995, namespace: 0 },
      { title: "Bird", pageid: 3410, namespace: 0 },
    ]);
    expect(result.structuredContent?.next_cursor).toBe("0|5910");
    expect(result.structuredContent?.has_more).toBe(true);
  });

  it("round-trips a cursor back to the module's own continuation parameter", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: { query: { backlinks: [] } } }]);

    await getBacklinksHandler({ title: "Kiwi (bird)", cursor: "0|5910" }, fakeEnv());

    expect((calledUrls(mock)[0] as URL).searchParams.get("blcontinue")).toBe("0|5910");
  });

  it("switches Action API module and cursor key per link type", async () => {
    for (const [type, list, titleParam, cursorKey] of [
      ["links_here", "backlinks", "bltitle", "blcontinue"],
      ["transclusions", "embeddedin", "eititle", "eicontinue"],
      ["file_usage", "imageusage", "iutitle", "iucontinue"],
    ] as const) {
      const mock = stubFetchRoutes([
        { match: anyUrl, body: { continue: { [cursorKey]: "0|1" }, query: { [list]: [{ pageid: 1, ns: 0, title: "X" }] } } },
      ]);

      const result = await getBacklinksHandler({ title: "Template:Taxobox", type }, fakeEnv());

      const url = calledUrls(mock)[0] as URL;
      expect(url.searchParams.get("list")).toBe(list);
      expect(url.searchParams.get(titleParam)).toBe("Template:Taxobox");
      expect(result.structuredContent?.next_cursor).toBe("0|1");
      vi.unstubAllGlobals();
    }
  });

  it("reports the end of the list as a null cursor", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { backlinks: [] } } }]);

    const result = await getBacklinksHandler({ title: "Kiwi (bird)" }, fakeEnv());

    expect(result.structuredContent?.next_cursor).toBeNull();
    expect(result.structuredContent?.has_more).toBe(false);
    expect(result.structuredContent?.returned).toBe(0);
  });

  it("only sends a namespace filter when one was requested", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: { query: { backlinks: [] } } }]);
    await getBacklinksHandler({ title: "Kiwi (bird)" }, fakeEnv());
    expect((calledUrls(mock)[0] as URL).searchParams.has("blnamespace")).toBe(false);

    vi.unstubAllGlobals();
    const scoped = stubFetchRoutes([{ match: anyUrl, body: { query: { backlinks: [] } } }]);
    await getBacklinksHandler({ title: "Kiwi (bird)", namespace: 0 }, fakeEnv());
    expect((calledUrls(scoped)[0] as URL).searchParams.get("blnamespace")).toBe("0");
  });

  it("says so when the target page does not exist, instead of a bare empty list", async () => {
    // These list modules answer HTTP 200 with [] for a title that does not exist, so an empty result
    // was indistinguishable from a real page nothing links to. `prop=info` rides along to tell them
    // apart.
    const mock = stubFetchRoutes([
      { match: anyUrl, body: { query: { pages: [{ ns: 0, title: "Zzzz Nope", missing: true }], backlinks: [] } } },
    ]);

    const result = await getBacklinksHandler({ title: "Zzzz Nope" }, fakeEnv());

    expect((calledUrls(mock)[0] as URL).searchParams.get("prop")).toBe("info");
    expect(result.structuredContent?.notice).toContain("No page titled 'Zzzz Nope' exists");
  });

  it("stays quiet when the target is missing but rows came back anyway", async () => {
    // Confirmed live: an uncreated File: page still has imageusage rows. Asserting "this empty
    // result means the title is wrong" over a populated list would be flatly false.
    stubFetchRoutes([
      {
        match: anyUrl,
        body: { query: { pages: [{ ns: 6, title: "File:X.pdf", missing: true }], imageusage: [{ pageid: 1, ns: 0, title: "Uses it" }] } },
      },
    ]);

    const result = await getBacklinksHandler({ title: "File:X.pdf", type: "file_usage" }, fakeEnv());

    expect((result.structuredContent?.links as unknown[]).length).toBe(1);
    expect(result.structuredContent?.notice).toBe("");
  });

  it("surfaces an upstream error as an actionable tool error", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { error: { code: "invalidtitle", info: "Bad title" } } }]);

    const result = await getBacklinksHandler({ title: "[bad]" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalidtitle");
  });
});
