import { afterEach, describe, expect, it, vi } from "vitest";
import { getPageHandler } from "../src/tools/getPage.js";
import { calledUrls, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const isExtract = (url: string) => url.includes("action=query") && url.includes("prop=extracts");
/** The one whole-page render: `prop=text|tocdata`, arriving percent-encoded as `text%7Ctocdata`. */
const isDocument = (url: string) => url.includes("action=parse") && url.includes("tocdata");
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

const TOC_SECTIONS = [
  { tocLevel: 1, hLevel: 2, line: "Etymology", number: "1", index: "1", fromTitle: "Kiwi_(bird)", codepointOffset: 5639, anchor: "Etymology" },
  { tocLevel: 2, hLevel: 3, line: "Species", number: "2.1", index: "3", fromTitle: "Kiwi_(bird)", codepointOffset: 11872, anchor: "Species" },
];

/**
 * The single `action=parse&prop=text|tocdata` response the page reader now makes.
 *
 * The HTML mirrors the live shape: `<div class="mw-heading mw-headingN"><hN id="anchor">` is the
 * section boundary, and the ids line up with `tocdata`'s anchors.
 */
function documentBody(
  html = "<p>Lead prose.</p>" +
    '<div class="mw-heading mw-heading2"><h2 id="Etymology">Etymology</h2></div><p>From te reo Māori.</p>' +
    '<div class="mw-heading mw-heading3"><h3 id="Species">Species</h3></div>' +
    "<p>There are five known extant species of kiwi.</p>",
) {
  return { parse: { title: "Kiwi (bird)", pageid: 17362, text: html, tocdata: { sections: TOC_SECTIONS, extensionData: [] } } };
}

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
      { match: isDocument, body: documentBody() },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", max_chars: 1000 }, fakeEnv());

    expect(result.structuredContent?.outline_only).toBe(true);
    // Each entry now carries `chars` — the exact length a `section` read of that index returns —
    // so the caller can budget instead of guessing.
    expect(result.structuredContent?.sections).toEqual([
      { index: "1", level: 2, number: "1", title: "Etymology", anchor: "Etymology", chars: "Etymology\nFrom te reo Māori.".length },
      {
        index: "3",
        level: 3,
        number: "2.1",
        title: "Species",
        anchor: "Species",
        chars: "Species\nThere are five known extant species of kiwi.".length,
      },
    ]);
    expect((result.structuredContent?.text as string).length).toBeLessThanOrEqual(1001);
    expect(result.structuredContent?.notice).toContain("`section`");
  });

  it("renders the page with one request, not one per section, and never uses prop=sections", async () => {
    // `prop=sections` is deprecated — the live API says so — and `&section=N` is worse still: it
    // renders in isolation, so a <ref> defined elsewhere emits `Cite error: ...` into the prose.
    const mock = stubFetchRoutes([
      { match: isExtract, body: extractBody({ extract: "x".repeat(5000) }) },
      { match: isDocument, body: documentBody() },
    ]);

    await getPageHandler({ title: "Kiwi (bird)", max_chars: 1000 }, fakeEnv());

    const parseCalls = calledUrls(mock).filter((url) => url.searchParams.get("action") === "parse");
    expect(parseCalls).toHaveLength(1);
    expect(parseCalls[0]?.searchParams.get("prop")).toBe("text|tocdata");
    expect(parseCalls[0]?.searchParams.get("section")).toBeNull();
    // Presence alone makes a MediaWiki boolean true, so this must never be sent as "0".
    expect(parseCalls[0]?.searchParams.get("mobileformat")).toBe("1");
  });

  it("reads one section as plain text, stripping edit links, reference markers and template CSS", async () => {
    stubFetchRoutes([
      { match: isExtract, body: extractBody() },
      {
        match: isDocument,
        body: documentBody(
          '<div class="mw-content-ltr mw-parser-output"><div class="mw-heading mw-heading3"><h3 id="Species">Species</h3>' +
            '<span class="mw-editsection"><span>[</span><a href="/w/index.php?action=edit"><span>edit</span></a><span>]</span></span></div>' +
            "<p>There are five known extant species of kiwi.<sup class=\"reference\"><a href=\"#cite_note-1\">[1]</a></sup></p>" +
            '<style data-mw-deduplicate="TemplateStyles:r1">.mw-parser-output div.clade{overflow-x:auto}</style></div>',
        ),
      },
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
      { match: isDocument, body: documentBody('<div class="mw-heading"><h3 id="Species">Species</h3></div><p>Section prose.</p>') },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", section: "3", max_chars: 500 }, fakeEnv());

    expect(result.structuredContent?.outline_only).toBe(false);
    expect(result.structuredContent?.text).toBe("Species\nSection prose.");
  });

  it("reads several sections in a single upstream request", async () => {
    // The reported cost was three calls to read one article: outline, then two sections. The second
    // and third are now free.
    const mock = stubFetchRoutes([
      { match: isExtract, body: extractBody() },
      { match: isDocument, body: documentBody() },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", section: ["1", "3"] }, fakeEnv());

    expect(calledUrls(mock).filter((url) => url.searchParams.get("action") === "parse")).toHaveLength(1);
    expect(result.structuredContent?.sections_read).toEqual([
      { index: "1", title: "Etymology", chars: "Etymology\nFrom te reo Māori.".length, text: "Etymology\nFrom te reo Māori." },
      {
        index: "3",
        title: "Species",
        chars: "Species\nThere are five known extant species of kiwi.".length,
        text: "Species\nThere are five known extant species of kiwi.",
      },
    ]);
    expect(result.structuredContent?.text).toContain("From te reo Māori.");
    expect(result.structuredContent?.text).toContain("five known extant species");
  });

  it("returns the sections it found and names the ones it did not", async () => {
    stubFetchRoutes([
      { match: isExtract, body: extractBody() },
      { match: isDocument, body: documentBody() },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", section: ["1", "99"] }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.notice).toContain("99");
    expect(result.structuredContent?.text).toContain("From te reo Māori.");
  });

  it("errors actionably when no requested section exists at all", async () => {
    stubFetchRoutes([
      { match: isExtract, body: extractBody() },
      { match: isDocument, body: documentBody() },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", section: "99" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("outline");
  });

  it("returns citations as structured rows when asked", async () => {
    const coins = "ctx_ver=Z39.88-2004&amp;rft.atitle=Kiwi+taxonomy&amp;rft.date=2019&amp;rft_id=info%3Adoi%2F10.1000%2Fxyz";
    stubFetchRoutes([
      { match: isExtract, body: extractBody() },
      {
        match: isDocument,
        body: documentBody(
          "<p>Lead prose.</p>" +
            '<div class="mw-references-wrap"><ol class="references">' +
            `<li id="cite_note-1"><span class="reference-text">Burbidge <span class="Z3988" title="${coins}"></span></span></li>` +
            "</ol></div>",
        ),
      },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", include_references: true }, fakeEnv());

    expect(result.structuredContent?.references).toEqual([
      { ref_id: "cite_note-1", text: "Burbidge", title: "Kiwi taxonomy", year: "2019", doi: "10.1000/xyz" },
    ]);
    // The prose must not also carry the citation dump.
    expect(result.structuredContent?.text).not.toContain("Burbidge");
  });

  it("still falls back to rendering when include_references is also set", async () => {
    // Review finding: `|| include_references` intercepted before the empty-extract fallback, so an
    // article opening with a template returned text:"" with no notice the moment references were
    // also asked for.
    stubFetchRoutes([
      { match: isExtract, body: extractBody({ extract: "" }) },
      { match: isDocument, body: documentBody("<p>Rendered instead.</p>") },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", include_references: true }, fakeEnv());

    expect(result.structuredContent?.text).toBe("Rendered instead.");
    expect(result.structuredContent?.references).toEqual([]);
  });

  it("names the sections it returned, not the ones it was asked for", async () => {
    stubFetchRoutes([
      { match: isExtract, body: extractBody() },
      { match: isDocument, body: documentBody() },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", section: ["1", "3", "99"] }, fakeEnv());

    expect(result.structuredContent?.section).toBe("1,3");
    expect(result.structuredContent?.notice).toContain("99");
  });

  it("says when a requested section rendered as empty", async () => {
    stubFetchRoutes([
      { match: isExtract, body: extractBody() },
      { match: isDocument, body: documentBody('<p>Lead.</p><div class="mw-heading"><h3 id="Species">Species</h3></div>') },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)", section: "3" }, fakeEnv());

    expect(result.structuredContent?.notice).toContain("rendered as empty");
  });

  it("treats a blank section as no section at all, rather than as an unmatched index", async () => {
    // `z.string().min(1)` accepts " ", which normalised to an empty list and produced
    // "has any of the indexes ." after a wasted whole-page render.
    stubFetchRoutes([{ match: isExtract, body: extractBody() }]);

    const result = await getPageHandler({ title: "Kiwi (bird)", section: "   " }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.text).toBe("Kiwi are flightless birds endemic to New Zealand.");
  });

  it("falls back to rendering the page when TextExtracts returns nothing", async () => {
    // Documented TextExtracts behaviour: an article that does not begin with a lead paragraph — one
    // opening with a template, or an unclosed element — yields an empty extract.
    stubFetchRoutes([
      { match: isExtract, body: extractBody({ extract: "" }) },
      { match: isDocument, body: documentBody("<p>Rendered instead.</p>") },
    ]);

    const result = await getPageHandler({ title: "Kiwi (bird)" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.text).toBe("Rendered instead.");
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
