import { afterEach, describe, expect, it, vi } from "vitest";
import { htmlToPlainText, stripInlineHtml } from "../src/html.js";
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

  it("ignores an out-of-range numeric entity rather than throwing", () => {
    expect(stripInlineHtml("a &#999999999; b")).toBe("a b");
  });
});

describe("htmlToPlainText", () => {
  it("drops style blocks, edit links and reference markers while keeping prose", async () => {
    const html =
      '<div class="mw-parser-output"><div class="mw-heading"><h3>Species</h3>' +
      '<span class="mw-editsection"><a href="/w/index.php?action=edit">edit</a></span></div>' +
      "<p>There are five species.<sup class=\"reference\"><a href=\"#cite_note-1\">[1]</a></sup></p>" +
      '<style data-mw-deduplicate="TemplateStyles:r1">.clade{overflow-x:auto}</style>' +
      "<script>alert(1)</script>";

    const text = await htmlToPlainText(html);

    expect(text).toContain("Species");
    expect(text).toContain("There are five species.");
    expect(text).not.toContain("edit");
    expect(text).not.toContain("[1]");
    expect(text).not.toContain("overflow-x");
    expect(text).not.toContain("alert");
  });

  it("collapses runs of whitespace and blank lines", async () => {
    expect(await htmlToPlainText("<p>a   b</p><p></p><p></p><p>c</p>")).toBe("a b\n\nc");
  });

  it("returns an empty string for empty input", async () => {
    expect(await htmlToPlainText("")).toBe("");
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
