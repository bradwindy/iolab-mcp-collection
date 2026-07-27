import { afterEach, describe, expect, it, vi } from "vitest";
import { readAttribution } from "../src/clients/commons.js";
import { getMediaInfoHandler } from "../src/tools/getMediaInfo.js";
import { searchMediaHandler } from "../src/tools/searchMedia.js";
import { calledUrls, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const anyUrl = () => true;

/** Verbatim shape of a live Commons extmetadata block: every value is wrapped, Artist can be HTML. */
const liveExtMetadata = {
  Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Alvesgaspar" title="User:Alvesgaspar">Alvesgaspar</a>', source: "commons-desc-page" },
  LicenseShortName: { value: "CC BY-SA 3.0", source: "commons-desc-page", hidden: "" },
  UsageTerms: { value: "Creative Commons Attribution-Share Alike 3.0", source: "commons-desc-page" },
  LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/3.0", source: "commons-desc-page" },
  AttributionRequired: { value: "true", source: "commons-desc-page", hidden: "" },
  ImageDescription: { value: "A <b>domestic cat</b> photographed in November 2010", source: "commons-desc-page" },
};

const liveImageInfo = {
  size: 2833605,
  width: 1795,
  height: 2397,
  // Confirmed live: thumbwidth echoes what was requested while thumburl carries the bucket Commons
  // actually rounded to — 400 requested, 500px- served.
  thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat.jpg/500px-Cat.jpg",
  thumbwidth: 400,
  thumbheight: 534,
  url: "https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat.jpg",
  descriptionurl: "https://commons.wikimedia.org/wiki/File:Cat.jpg",
  mime: "image/jpeg",
  extmetadata: liveExtMetadata,
};

describe("readAttribution", () => {
  it("unwraps the {value, source, hidden} envelope and strips HTML out of Artist", () => {
    expect(readAttribution(liveExtMetadata)).toEqual({
      artist: "Alvesgaspar",
      license: "CC BY-SA 3.0",
      license_url: "https://creativecommons.org/licenses/by-sa/3.0",
      usage_terms: "Creative Commons Attribution-Share Alike 3.0",
      attribution_required: true,
    });
  });

  it("reads AttributionRequired as the string it actually is, not as truthiness", () => {
    // Every extmetadata value is a string; "false" is truthy in JavaScript.
    expect(readAttribution({ AttributionRequired: { value: "false" } }).attribution_required).toBe(false);
  });

  it("returns an empty object rather than throwing when extmetadata is absent", () => {
    expect(readAttribution(undefined)).toEqual({});
  });
});

describe("wikimedia_search_media", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns file URLs with licensing alongside each result", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          batchcomplete: true,
          continue: { gsroffset: 2, continue: "gsroffset||" },
          query: {
            searchinfo: { totalhits: 6200 },
            pages: [{ pageid: 1368325, ns: 6, title: "File:Apteryx owenii 0.jpg", index: 1, imageinfo: [liveImageInfo] }],
          },
        },
      },
    ]);

    const result = await searchMediaHandler({ query: "kiwi bird" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.files).toEqual([
      {
        title: "File:Apteryx owenii 0.jpg",
        pageid: 1368325,
        mime: "image/jpeg",
        width: 1795,
        height: 2397,
        size_bytes: 2833605,
        file_url: "https://upload.wikimedia.org/wikipedia/commons/4/4d/Cat.jpg",
        thumbnail_url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Cat.jpg/500px-Cat.jpg",
        description_url: "https://commons.wikimedia.org/wiki/File:Cat.jpg",
        license: "CC BY-SA 3.0",
        artist: "Alvesgaspar",
      },
    ]);
    expect(result.structuredContent?.total_count).toBe(6200);
  });

  it("searches Commons, restricted to the File namespace", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: { query: { searchinfo: { totalhits: 0 }, pages: [] } } }]);

    await searchMediaHandler({ query: "kiwi" }, fakeEnv());

    const url = calledUrls(mock)[0] as URL;
    expect(url.host).toBe("commons.wikimedia.org");
    expect(url.searchParams.get("gsrnamespace")).toBe("6");
  });

  it("maps file_type onto a Cirrus filetype: filter and leaves 'any' unfiltered", async () => {
    const filtered = stubFetchRoutes([{ match: anyUrl, body: { query: { pages: [] } } }]);
    await searchMediaHandler({ query: "kiwi", file_type: "bitmap" }, fakeEnv());
    expect((calledUrls(filtered)[0] as URL).searchParams.get("gsrsearch")).toBe("filetype:bitmap kiwi");

    vi.unstubAllGlobals();
    const unfiltered = stubFetchRoutes([{ match: anyUrl, body: { query: { pages: [] } } }]);
    await searchMediaHandler({ query: "kiwi", file_type: "any" }, fakeEnv());
    expect((calledUrls(unfiltered)[0] as URL).searchParams.get("gsrsearch")).toBe("kiwi");
  });

  it("restores relevance order, which generator= responses do not preserve", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          query: {
            searchinfo: { totalhits: 3 },
            pages: [
              { pageid: 3, ns: 6, title: "File:Third.jpg", index: 3, imageinfo: [{}] },
              { pageid: 1, ns: 6, title: "File:First.jpg", index: 1, imageinfo: [{}] },
              { pageid: 2, ns: 6, title: "File:Second.jpg", index: 2, imageinfo: [{}] },
            ],
          },
        },
      },
    ]);

    const result = await searchMediaHandler({ query: "kiwi" }, fakeEnv());

    expect((result.structuredContent?.files as Array<{ title: string }>).map((file) => file.title)).toEqual([
      "File:First.jpg",
      "File:Second.jpg",
      "File:Third.jpg",
    ]);
  });

  it("refuses to page past the search ceiling before calling upstream", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: { query: { pages: [] } } }]);

    const result = await searchMediaHandler({ query: "kiwi", offset: 9999, limit: 10 }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });

  it("returns an empty result set without erroring", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { searchinfo: { totalhits: 0 } } } }]);

    const result = await searchMediaHandler({ query: "zzznotathing" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.files).toEqual([]);
    expect(result.structuredContent?.notice).toBe("");
  });
});

describe("wikimedia_get_media_info", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns full attribution with the description HTML stripped", async () => {
    stubFetchRoutes([
      { match: anyUrl, body: { batchcomplete: true, query: { pages: [{ pageid: 12127693, ns: 6, title: "File:Cat.jpg", imageinfo: [liveImageInfo] }] } } },
    ]);

    const result = await getMediaInfoHandler({ title: "Cat.jpg" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.description).toBe("A domestic cat photographed in November 2010");
    expect(result.structuredContent?.credit).toEqual({
      artist: "Alvesgaspar",
      license: "CC BY-SA 3.0",
      license_url: "https://creativecommons.org/licenses/by-sa/3.0",
      usage_terms: "Creative Commons Attribution-Share Alike 3.0",
      attribution_required: true,
    });
    expect(result.structuredContent?.notice).toContain("requires attribution");
  });

  it("adds the File: prefix when the caller omits it, and respects one already present", async () => {
    for (const [input, expected] of [
      ["Cat.jpg", "File:Cat.jpg"],
      ["File:Cat.jpg", "File:Cat.jpg"],
      ["Image:Cat.jpg", "Image:Cat.jpg"],
    ] as const) {
      const mock = stubFetchRoutes([
        { match: anyUrl, body: { query: { pages: [{ pageid: 1, ns: 6, title: expected, imageinfo: [liveImageInfo] }] } } },
      ]);
      await getMediaInfoHandler({ title: input }, fakeEnv());
      expect((calledUrls(mock)[0] as URL).searchParams.get("titles")).toBe(expected);
      vi.unstubAllGlobals();
    }
  });

  it("always reads from Commons, where files live even when used on a local wiki", async () => {
    // Confirmed live: the local-wiki file route 404s for a file hosted on Commons.
    const mock = stubFetchRoutes([
      { match: anyUrl, body: { query: { pages: [{ pageid: 1, ns: 6, title: "File:Cat.jpg", imageinfo: [liveImageInfo] }] } } },
    ]);

    await getMediaInfoHandler({ title: "Cat.jpg" }, fakeEnv());

    expect((calledUrls(mock)[0] as URL).host).toBe("commons.wikimedia.org");
  });

  it("omits the attribution notice when the licence does not require it", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          query: {
            pages: [
              {
                pageid: 1,
                ns: 6,
                title: "File:PD.jpg",
                imageinfo: [{ ...liveImageInfo, extmetadata: { LicenseShortName: { value: "Public domain" }, AttributionRequired: { value: "false" } } }],
              },
            ],
          },
        },
      },
    ]);

    const result = await getMediaInfoHandler({ title: "PD.jpg" }, fakeEnv());

    expect(result.structuredContent?.notice).toBe("");
    expect(result.structuredContent?.description).toBeUndefined();
  });

  it("turns a nonexistent file into an actionable error", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [{ ns: 6, title: "File:Nope.jpg", missing: true }] } } }]);

    const result = await getMediaInfoHandler({ title: "Nope.jpg" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("wikimedia_search_media");
  });
});
