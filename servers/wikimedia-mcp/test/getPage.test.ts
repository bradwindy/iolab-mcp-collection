import { afterEach, describe, expect, it, vi } from "vitest";
import { getPageHandler } from "../src/tools/getPage.js";
import { calledUrls, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const isExtract = (url: string) => url.includes("action=query") && url.includes("prop=extracts");
const isToc = (url: string) => url.includes("action=parse") && url.includes("prop=tocdata");
const isSectionText = (url: string) => url.includes("action=parse") && url.includes("prop=text");
const isLinks = (url: string) => url.includes("action=parse") && url.includes("prop=links");

function extractBody(overrides: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  return {
    batchcomplete: true,
    query: {
      ...envelope,
      pages: [
        {
          pageid: 17362,
          ns: 0,
          title: "Kiwi (bird)",
          extract: "Kiwi are flightless birds endemic to New Zealand.",
          description: "Order of birds",
          canonicalurl: "https://en.wikipedia.org/wiki/Kiwi_(bird)",
          pageprops: { wikibase_item: "Q43642" },
          ...overrides,
        },
      ],
    },
  };
}

const tocBody = {
  parse: {
    title: "Kiwi (bird)",
    pageid: 17362,
    tocdata: {
      sections: [
        { tocLevel: 1, hLevel: 2, line: "Etymology", number: "1", index: "1", fromTitle: "Kiwi_(bird)", codepointOffset: 5639, anchor: "Etymology" },
        { tocLevel: 2, hLevel: 3, line: "Species", number: "2.1", index: "3", fromTitle: "Kiwi_(bird)", codepointOffset: 11872, anchor: "Species" },
      ],
      extensionData: [],
    },
  },
};

describe("wikimedia_get_page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the whole article when it fits inside the character budget", async () => {
    stubFetchRoutes([{ match: isExtract, body: extractBody() }]);

    const result = await getPageHandler({ title: "Kiwi (bird)" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.outline_only).toBe(false);
    expect(result.structuredContent?.text).toBe("Kiwi are flightless birds endemic to New Zealand.");
    expect(result.structuredContent?.wikibase_item).toBe("Q43642");
    expect(result.structuredContent?.sections).toBeUndefined();
  });

  it("returns a section outline instead of the text when the article overflows the budget", async () => {
    // World War II's plaintext extract measures ~86,000 characters live; without this an article
    // that size lands in the model's context whole.
    stubFetchRoutes([
      { match: isExtract, body: extractBody({ extract: "x".repeat(5000) }) },
      { match: isToc, body: tocBody },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", max_chars: 1000 }, fakeEnv());

    expect(result.structuredContent?.outline_only).toBe(true);
    expect(result.structuredContent?.sections).toEqual([
      { index: "1", level: 2, number: "1", title: "Etymology", anchor: "Etymology" },
      { index: "3", level: 3, number: "2.1", title: "Species", anchor: "Species" },
    ]);
    expect((result.structuredContent?.text as string).length).toBe(1000);
    expect(result.structuredContent?.notice).toContain("`section`");
  });

  it("uses prop=tocdata, never the deprecated prop=sections", async () => {
    // Confirmed live: the API responds to prop=sections with
    // '"prop=sections" has been deprecated. Please use "prop=tocdata" instead.'
    const mock = stubFetchRoutes([
      { match: isExtract, body: extractBody({ extract: "x".repeat(5000) }) },
      { match: isToc, body: tocBody },
    ]);

    await getPageHandler({ title: "Kiwi (bird)", max_chars: 1000 }, fakeEnv());

    const props = calledUrls(mock).map((url) => url.searchParams.get("prop"));
    expect(props).toContain("tocdata");
    expect(props).not.toContain("sections");
  });

  it("reads one section as plain text, stripping edit links, reference markers and template CSS", async () => {
    stubFetchRoutes([
      { match: isExtract, body: extractBody() },
      {
        match: isSectionText,
        body: {
          parse: {
            title: "Kiwi (bird)",
            pageid: 17362,
            // Verbatim shape of live section HTML, including the TemplateStyles <style> block that
            // would otherwise be emitted as body text.
            text:
              '<div class="mw-content-ltr mw-parser-output"><div class="mw-heading mw-heading3"><h3 id="Species">Species</h3>' +
              '<span class="mw-editsection"><span>[</span><a href="/w/index.php?action=edit"><span>edit</span></a><span>]</span></span></div>' +
              "<p>There are five known extant species of kiwi.<sup class=\"reference\"><a href=\"#cite_note-1\">[1]</a></sup></p>" +
              '<style data-mw-deduplicate="TemplateStyles:r1">.mw-parser-output div.clade{overflow-x:auto}</style>',
          },
        },
      },
      { match: isToc, body: tocBody },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", section: "3" }, fakeEnv());

    const text = result.structuredContent?.text as string;
    expect(text).toContain("Species");
    expect(text).toContain("There are five known extant species of kiwi.");
    expect(text).not.toContain("edit");
    expect(text).not.toContain("[1]");
    expect(text).not.toContain("overflow-x");
    expect(result.structuredContent?.section_title).toBe("Species");
    expect(result.structuredContent?.outline_only).toBe(false);
  });

  it("never outlines away a section-targeted read, however small the budget", async () => {
    stubFetchRoutes([
      { match: isExtract, body: extractBody({ extract: "x".repeat(5000) }) },
      { match: isSectionText, body: { parse: { title: "Kiwi (bird)", text: "<p>Section prose.</p>" } } },
      { match: isToc, body: tocBody },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", section: "3", max_chars: 500 }, fakeEnv());

    expect(result.structuredContent?.outline_only).toBe(false);
    expect(result.structuredContent?.text).toBe("Section prose.");
  });

  it("returns a disambiguation page's options rather than its prose", async () => {
    // A disambiguation extract ("Kiwi most commonly refers to: ...") reads like an answer but names
    // several unrelated subjects, so returning it as article text produces confident wrong answers.
    stubFetchRoutes([
      {
        match: isExtract,
        body: extractBody({
          title: "Kiwi",
          pageid: 18430646,
          extract: "Kiwi most commonly refers to:",
          description: "Topics referred to by the same term",
          // The marker is an EMPTY STRING in both format versions — key presence is the signal.
          pageprops: { disambiguation: "", wikibase_item: "Q5574340" },
        }),
      },
      {
        match: isLinks,
        body: {
          parse: {
            title: "Kiwi",
            links: [
              { ns: 0, title: "Kiwi (bird)", exists: true },
              { ns: 0, title: "Kiwifruit", exists: true },
              { ns: 14, title: "Category:Set indices", exists: true },
              { ns: 0, title: "Kiwi (nonexistent)", exists: false },
            ],
          },
        },
      },
    ]);

    const result = await getPageHandler({ title: "Kiwi" }, fakeEnv());

    expect(result.structuredContent?.is_disambiguation).toBe(true);
    // Only existing mainspace links: no category pages, no redlinks.
    expect(result.structuredContent?.disambiguation_options).toEqual(["Kiwi (bird)", "Kiwifruit"]);
    expect(result.structuredContent?.notice).toContain("disambiguation page");
  });

  it("does not treat an article as a disambiguation page just because pageprops exists", async () => {
    stubFetchRoutes([{ match: isExtract, body: extractBody({ pageprops: { wikibase_item: "Q43642" } }) }]);

    const result = await getPageHandler({ title: "Kiwi (bird)" }, fakeEnv());

    expect(result.structuredContent?.is_disambiguation).toBe(false);
    expect(result.structuredContent?.disambiguation_options).toBeUndefined();
  });

  it("reports normalisation and redirection as two distinct facts", async () => {
    // Confirmed live: 'kiwi bird' is normalised to 'Kiwi bird' and then redirected to 'Kiwi (bird)'.
    // Collapsing them loses the difference between a capitalisation fixup and an editorial redirect.
    stubFetchRoutes([
      {
        match: isExtract,
        body: extractBody(
          {},
          {
            normalized: [{ fromencoded: false, from: "kiwi bird", to: "Kiwi bird" }],
            redirects: [{ from: "Kiwi bird", to: "Kiwi (bird)" }],
          },
        ),
      },
    ]);

    const result = await getPageHandler({ title: "kiwi bird" }, fakeEnv());

    expect(result.structuredContent?.normalized_from).toBe("kiwi bird");
    expect(result.structuredContent?.redirected_from).toBe("Kiwi bird");
    expect(result.structuredContent?.title).toBe("Kiwi (bird)");
  });

  it("reports null for both when a title needed no rewriting", async () => {
    stubFetchRoutes([{ match: isExtract, body: extractBody() }]);

    const result = await getPageHandler({ title: "Kiwi (bird)" }, fakeEnv());

    expect(result.structuredContent?.normalized_from).toBeNull();
    expect(result.structuredContent?.redirected_from).toBeNull();
  });

  it("turns the API's missing marker into an actionable error rather than crashing", async () => {
    // Unlike the REST API, the Action API answers 200 with `missing: true` for a nonexistent page.
    stubFetchRoutes([
      { match: isExtract, body: { batchcomplete: true, query: { pages: [{ ns: 0, title: "Nope12345", missing: true }] } } },
    ]);

    const result = await getPageHandler({ title: "Nope12345" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No page titled 'Nope12345'");
    expect(result.content[0]?.text).toContain("wikimedia_search_pages");
  });

  it("surfaces an invalid title with the wiki's own reason", async () => {
    stubFetchRoutes([
      {
        match: isExtract,
        body: {
          batchcomplete: true,
          query: { pages: [{ ns: 0, title: "[bad]", invalid: true, invalidreason: 'The requested page title contains invalid characters: "[".' }] },
        },
      },
    ]);

    const result = await getPageHandler({ title: "[bad]" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid characters");
  });

  it("surfaces an upstream transport failure as a retryable error", async () => {
    stubFetchRoutes([{ match: isExtract, body: { error: "boom" }, status: 503 }]);

    const result = await getPageHandler({ title: "Kiwi (bird)" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("503");
  });

  it("reads a non-English wiki through the same code path", async () => {
    const mock = stubFetchRoutes([{ match: isExtract, body: extractBody({ title: "Kiwi", extract: "He manu rere kore te kiwi." }) }]);

    const result = await getPageHandler({ title: "Kiwi", lang: "mi" }, fakeEnv());

    expect((calledUrls(mock)[0] as URL).host).toBe("mi.wikipedia.org");
    expect(result.structuredContent?.text).toBe("He manu rere kore te kiwi.");
  });
});
