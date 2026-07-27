import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePageDocument, stripInlineHtml } from "../src/html.js";
import { resolveWikiHost, PROJECTS } from "../src/projects.js";
import { getOptionalWikimediaToken } from "../src/credentials.js";
import { wikimediaFetch, serially, USER_AGENT } from "../src/clients/http.js";
import { encryptValue } from "@iolab/credentials";
import { calledHeaders, fakeEnv, jsonResponse, TEST_ENCRYPTION_KEY } from "./support/fakeEnv.js";

describe("resolveWikiHost", () => {
  it("builds a per-language host for every project that has language editions", () => {
    expect(resolveWikiHost("wikipedia", "en")).toBe("en.wikipedia.org");
    expect(resolveWikiHost("wikipedia", "mi")).toBe("mi.wikipedia.org");
    expect(resolveWikiHost("wiktionary", "fr")).toBe("fr.wiktionary.org");
    expect(resolveWikiHost("wikivoyage", "de")).toBe("de.wikivoyage.org");
  });

  it("special-cases wikispecies, which has no language editions at all", () => {
    // Confirmed live: species.wikimedia.org serves the API and en.wikispecies.org 301s away, so
    // the generic {lang}.{project}.org template silently breaks for exactly this one project.
    expect(resolveWikiHost("wikispecies", "en")).toBe("species.wikimedia.org");
    expect(resolveWikiHost("wikispecies", "de")).toBe("species.wikimedia.org");
  });

  it("lower-cases the language code so 'EN' cannot produce a dead host", () => {
    expect(resolveWikiHost("wikipedia", "EN")).toBe("en.wikipedia.org");
  });

  it("produces a wikimedia.org or {project}.org host for every project in the enum", () => {
    for (const project of PROJECTS) {
      const host = resolveWikiHost(project, "en");
      expect(host).toMatch(/^[a-z.]+\.(org)$/);
    }
  });
});

describe("stripInlineHtml", () => {
  it("removes tags and decodes the entities Wikimedia escapes", () => {
    expect(stripInlineHtml('<span class="searchmatch">Kiwi</span> are New Zealand&#039;s birds')).toBe("Kiwi are New Zealand's birds");
  });

  it("decodes named and hex entities", () => {
    expect(stripInlineHtml("a &lt;b&gt; c &#x2014; d &nbsp;e")).toBe("a <b> c — d e");
  });

  it("does not re-decode an entity that was itself escaped", () => {
    // &amp;lt; must end up as the literal text "&lt;", not as "<" — decoding &amp; last is what
    // stops a double-decode.
    expect(stripInlineHtml("&amp;lt;")).toBe("&lt;");
  });

  it("drops a numeric entity that is well-formed but outside Unicode", () => {
    // 0x10FFFF is the top of the code space; seven digits is the most a real reference can carry.
    expect(stripInlineHtml("a &#1114112; b")).toBe("a b");
  });

  it("leaves a malformed reference as literal text rather than deleting it", () => {
    // Nine digits cannot be a character reference at all, so it is page text an editor wrote.
    // Silently removing it would lose content; the digit bound also keeps the regex from being
    // handed an unbounded run of digits.
    expect(stripInlineHtml("a &#999999999; b")).toBe("a &#999999999; b");
  });

  it("drops a surrogate half, which cannot stand alone", () => {
    // String.fromCodePoint accepts these and yields a lone surrogate that breaks JSON serialisation
    // further down.
    expect(stripInlineHtml("a &#xD800; b")).toBe("a b");
  });
});

const OUTLINE = [
  { index: "1", level: 2, number: "1", title: "Species", anchor: "Species" },
  { index: "2", level: 2, number: "2", title: "Geology", anchor: "Geology" },
];

async function textOf(html: string, anchor?: string): Promise<string> {
  const { sections } = await parsePageDocument(html, OUTLINE);
  const target = anchor === undefined ? sections[0] : sections.find((section) => section.anchor === anchor);
  return target?.text ?? "";
}

describe("parsePageDocument", () => {
  it("drops style blocks, edit links and reference markers while keeping prose", async () => {
    const html =
      '<div class="mw-parser-output"><div class="mw-heading"><h3 id="Species">Species</h3>' +
      '<span class="mw-editsection"><a href="/w/index.php?action=edit">edit</a></span></div>' +
      "<p>There are five species.<sup class=\"reference\"><a href=\"#cite_note-1\">[1]</a></sup></p>" +
      '<style data-mw-deduplicate="TemplateStyles:r1">.clade{overflow-x:auto}</style>' +
      "<script>alert(1)</script></div>";

    const text = await textOf(html, "Species");

    expect(text).toContain("Species");
    expect(text).toContain("There are five species.");
    expect(text).not.toContain("edit");
    expect(text).not.toContain("[1]");
    expect(text).not.toContain("overflow-x");
    expect(text).not.toContain("alert");
  });

  it("decodes the character references HTMLRewriter hands back raw", async () => {
    // This is the reported defect: HTMLRewriter's text handler returns the source slice, so a
    // section read used to emit `25–30&#160;km (16–19&#160;mi)` and `Water &amp; Atmosphere`
    // verbatim. The whole-page extract path never showed it because MediaWiki decodes server-side.
    const text = await textOf("<p>25–30&#160;km and Water &amp; Atmosphere</p>");
    expect(text).toBe("25–30 km and Water & Atmosphere");
  });

  it("does not double-decode an entity an editor escaped on purpose", async () => {
    expect(await textOf("<p>&amp;#160;</p>")).toBe("&#160;");
    expect(await textOf("<p>&amp;lt;</p>")).toBe("&lt;");
  });

  it("drops the reference list, map legends and cite errors from the prose", async () => {
    // All three were reported from a live section read of `Taupō Volcano`. The cite error is
    // structurally impossible on a whole-page parse, but a stray inline one must still not surface.
    const html =
      "<p>Real prose.</p>" +
      '<div class="legend"><span class="legend-color" style="background:#dd6600"></span>Rhyolite</div>' +
      '<span class="error mw-ext-cite-error">Cite error: The named reference Lowe2021 was invoked but never defined</span>' +
      '<div class="mw-references-wrap"><ol class="references">' +
      '<li id="cite_note-1"><span class="mw-cite-backlink"><a href="#cite_ref-1">^</a></span>' +
      '<span class="reference-text">Seebeck, H. A. (2014). "Structure and kinematics of the Taupo Rift".</span></li>' +
      "</ol></div>";

    const text = await textOf(html);

    expect(text).toBe("Real prose.");
    expect(text).not.toContain("Rhyolite");
    expect(text).not.toContain("Cite error");
    expect(text).not.toContain("Seebeck");
  });

  it("splits on heading id matched against the outline anchor, not on position", async () => {
    // A heading the TOC omits must not shift every later section by one.
    const html =
      "<p>Lead text.</p>" +
      '<div class="mw-heading"><h2 id="Untracked">Untracked</h2></div><p>Stray.</p>' +
      '<div class="mw-heading"><h2 id="Geology">Geology</h2></div><p>Geology text.</p>';

    const { sections } = await parsePageDocument(html, OUTLINE);

    expect(sections.map((section) => section.index)).toEqual(["0", "2"]);
    expect(sections[1]?.text).toContain("Geology text.");
    expect(sections[0]?.text).toContain("Stray.");
  });

  it("reports each section's exact rendered length", async () => {
    const html = '<p>Lead.</p><div class="mw-heading"><h2 id="Geology">Geology</h2></div><p>Rhyolite.</p>';

    const { sections } = await parsePageDocument(html, OUTLINE);

    for (const section of sections) expect(section.chars).toBe(section.text.length);
  });

  it("harvests citations from the COinS metadata the cite templates emit", async () => {
    // There is no references API — /api/rest_v1/page/references/ 404s on every title tried — so the
    // span.Z3988 OpenURL blob is the only machine-readable citation data available.
    const coins =
      "ctx_ver=Z39.88-2004&amp;rft.genre=article&amp;rft.jtitle=Radiocarbon&amp;rft.atitle=Testing+IntCal20" +
      "&amp;rft.date=2020&amp;rft_id=info%3Adoi%2F10.1017%2FRDC.2020.54&amp;rft.au=Muscheler%2C+Raimund";
    const html =
      '<div class="mw-references-wrap"><ol class="references">' +
      `<li id="cite_note-lowe-3"><span class="reference-text">Lowe et al. <cite class="citation"><span title="${coins}" class="Z3988"></span></cite></span></li>` +
      "</ol></div>";

    const { references } = await parsePageDocument(html, OUTLINE);

    expect(references).toEqual([
      {
        ref_id: "cite_note-lowe-3",
        text: "Lowe et al.",
        title: "Testing IntCal20",
        publication: "Radiocarbon",
        year: "2020",
        authors: ["Muscheler, Raimund"],
        doi: "10.1017/RDC.2020.54",
      },
    ]);
  });

  it("survives a void element carrying a skip class", async () => {
    // Review finding: `onEndTag` throws `TypeError: Parser error: No end tag.` on <br>/<hr>/<img>,
    // which aborted the whole page read as a protocol error. `class` on a void element is
    // sanitizer-allowed on every wiki. There is no `canHaveContent` property in this workerd
    // version to test with — it is `undefined` even on <div> — so the guard has to catch.
    // <br> is a block element here, so it still contributes its line break — the point is that the
    // read completes at all, and that the text either side survives.
    expect(await textOf('<p>Alpha<br class="noprint" />Beta</p>')).toBe("Alpha\nBeta");
    expect(await textOf('<p>A</p><hr class="metadata"><p>B</p>')).toBe("A\nB");
    expect(await textOf('<p>A</p><img class="metadata"><p>B</p>')).toBe("A\nB");
  });

  it("keeps skipping after a void element inside the skipped subtree", async () => {
    // The undo must not leak: a <br> inside a navbox must not end the navbox's suppression.
    const text = await textOf('<p>Kept.</p><div class="navbox">Junk<br/>More junk</div><p>Also kept.</p>');
    expect(text).toContain("Kept.");
    expect(text).toContain("Also kept.");
    expect(text).not.toContain("Junk");
  });

  it("collapses runs of whitespace and blank lines", async () => {
    expect(await textOf("<p>a   b</p><p></p><p></p><p>c</p>")).toBe("a b\n\nc");
  });

  it("keeps the backlink markers out of a citation's text", async () => {
    // Review finding: the text handler checked `currentRef` before `skipDepth`, so `.mw-cite-backlink`
    // — which is in the skip list precisely because it lives inside the <li> — was collected into the
    // reference, prefixing every real citation with "^ " or "^ a b ".
    const html =
      '<div class="mw-references-wrap"><ol class="references">' +
      '<li id="cite_note-1"><span class="mw-cite-backlink">^ <a href="#a"><i><b>a</b></i></a> <a href="#b"><i><b>b</b></i></a></span> ' +
      '<span class="reference-text">Seebeck, H. A. (2014).</span></li>' +
      "</ol></div>";

    const { references } = await parsePageDocument(html, OUTLINE);

    expect(references).toEqual([{ ref_id: "cite_note-1", text: "Seebeck, H. A. (2014)." }]);
  });

  it("resumes the outer reference after a nested one closes", async () => {
    const html =
      '<div class="mw-references-wrap"><ol class="references">' +
      '<li id="cite_note-outer">Outer <ol class="references"><li id="cite_note-inner">Inner</li></ol> Tail</li>' +
      "</ol></div>";

    const { references } = await parsePageDocument(html, OUTLINE);

    expect(references.find((reference) => reference.ref_id === "cite_note-inner")?.text).toBe("Inner");
    expect(references.find((reference) => reference.ref_id === "cite_note-outer")?.text).toBe("Outer Tail");
  });

  it("returns an empty lead for empty input", async () => {
    const { sections, references } = await parsePageDocument("", OUTLINE);
    expect(sections).toEqual([{ index: "0", level: 1, number: "", title: "", anchor: "", text: "", chars: 0 }]);
    expect(references).toEqual([]);
  });
});

describe("credentials", () => {
  it("returns null when no token is configured, so every tool works anonymously", async () => {
    // The fake credentials DB is empty, which is the shipped default: 200 req/min with a compliant
    // User-Agent is well beyond interactive use, so the token is genuinely optional.
    expect(await getOptionalWikimediaToken(fakeEnv())).toBeNull();
  });

  it("returns a configured token", async () => {
    // A real Wikimedia token can't be obtained here, but the decrypt path is the repo's own and can
    // be exercised with a dummy value — otherwise a typo in the key name would ship silently.
    const stored = await encryptValue("tok-123", TEST_ENCRYPTION_KEY);
    expect(await getOptionalWikimediaToken(fakeEnv({ encryptedToken: stored }))).toBe("tok-123");
  });

  it("degrades to anonymous when the credential store fails, rather than breaking every tool", async () => {
    // getCredential can reject on a D1 outage, a bad ENCRYPTION_KEY, or a corrupted row. Since
    // every upstream request awaits it, propagating would take down all eleven tools — including
    // the anonymous path that needs no credential at all.
    expect(await getOptionalWikimediaToken(fakeEnv({ failingCredentials: true }))).toBeNull();
  });
});

describe("wikimediaFetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a policy-compliant User-Agent on every request", async () => {
    // Confirmed live: a library-default User-Agent gets a 403 from HAProxy before MediaWiki sees
    // the request, and an unidentified client is throttled to 10 req/min instead of 200.
    const mock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal("fetch", mock);

    await wikimediaFetch(fakeEnv(), "https://en.wikipedia.org/w/api.php");

    expect(calledHeaders(mock).get("user-agent")).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/^\S+\/\S+ \(\+https?:\/\/\S+\)$/);
  });

  it("omits Authorization entirely when no token is configured", async () => {
    const mock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal("fetch", mock);

    await wikimediaFetch(fakeEnv(), "https://en.wikipedia.org/w/api.php");

    expect(calledHeaders(mock).has("authorization")).toBe(false);
  });

  it("sends a Bearer header when a token is configured, and never leaks it into a response", async () => {
    const mock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal("fetch", mock);
    const stored = await encryptValue("tok-123", TEST_ENCRYPTION_KEY);

    const response = await wikimediaFetch(fakeEnv({ encryptedToken: stored }), "https://en.wikipedia.org/w/api.php");

    expect(calledHeaders(mock).get("authorization")).toBe("Bearer tok-123");
    // The decrypted credential must never reach the caller, at any response format.
    expect(JSON.stringify(await response.json())).not.toContain("tok-123");
  });

  it("preserves caller-supplied headers alongside the User-Agent", async () => {
    const mock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({})));
    vi.stubGlobal("fetch", mock);

    await wikimediaFetch(fakeEnv(), "https://query.wikidata.org/sparql", { headers: { Accept: "application/sparql-results+json" } });

    expect(calledHeaders(mock).get("accept")).toBe("application/sparql-results+json");
    expect(calledHeaders(mock).get("user-agent")).toBe(USER_AGENT);
  });
});

describe("serially", () => {
  it("runs tasks one at a time, since the Action API allows one concurrent request", async () => {
    // The Robot policy caps an unauthenticated client at concurrency 1 for the Action API, so the
    // Promise.all fan-out used elsewhere in this collection is the wrong shape here.
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(`${name}:start`);
      await Promise.resolve();
      order.push(`${name}:end`);
      return name;
    };

    const results = await serially([task("a"), task("b")]);

    expect(results).toEqual(["a", "b"]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });
});
