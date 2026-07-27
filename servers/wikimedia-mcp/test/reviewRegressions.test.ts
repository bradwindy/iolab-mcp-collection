/**
 * Regression tests for the eleven defects found in code review of this server's first draft. Each
 * one names the failure it locks out; none of them were caught by the original suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRowLimit, assertReadOnlySparql, scrubSparqlLiterals, SparqlRejectedError, stripSparqlComments } from "../src/clients/sparql.js";
import { entityUrl } from "../src/clients/wikidata.js";
import { byteLength, cacheKey } from "../src/cacheKeys.js";
import { getEntityHandler } from "../src/tools/getEntity.js";
import { getPageHandler } from "../src/tools/getPage.js";
import { getPageCategoriesHandler } from "../src/tools/getPageCategories.js";
import { getPageMetadataHandler } from "../src/tools/getPageMetadata.js";
import { searchEntitiesHandler } from "../src/tools/searchEntities.js";
import { queryWikidataSparqlHandler } from "../src/tools/queryWikidataSparql.js";
import { calledUrls, createFakeCache, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const anyUrl = () => true;
const isRest = (url: string) => url.includes("/rest.php/wikibase/v1/");
const isLabels = (url: string) => url.includes("action=wbgetentities");

describe("#1 injected LIMIT must not corrupt a trailing VALUES clause", () => {
  it("skips injection when the query uses VALUES", () => {
    // SPARQL puts ValuesClause AFTER SolutionModifier, so an appended LIMIT is a syntax error.
    // Confirmed live: the query returns 200 as written and 400 with `\nLIMIT 100` appended.
    const query = "SELECT ?s WHERE { ?s wdt:P31 ?x } VALUES ?s { wd:Q42 }";
    expect(applyRowLimit(query, 100)).toBe(query);
  });

  it("still injects for an ordinary query", () => {
    expect(applyRowLimit("SELECT ?s WHERE { ?s ?p ?o }", 100)).toBe("SELECT ?s WHERE { ?s ?p ?o }\nLIMIT 101");
  });
});

describe("#2 SPARQL has_more must be able to be true", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for one row beyond the limit so a full page can be distinguished from more", () => {
    // Injecting exactly `limit` made `has_more` structurally impossible: the service could never
    // return more rows than were asked for, so a query matching millions reported has_more: false.
    expect(applyRowLimit("SELECT ?s WHERE { ?s ?p ?o }", 5)).toContain("LIMIT 6");
  });

  it("reports has_more when the probe row comes back, and hides it from the results", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          head: { vars: ["s"] },
          results: { bindings: Array.from({ length: 6 }, (_, index) => ({ s: { type: "literal", value: `row-${index}` } })) },
        },
      },
    ]);

    const result = await queryWikidataSparqlHandler({ query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 5 }, fakeEnv());

    expect((result.structuredContent?.rows as unknown[]).length).toBe(5);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.notice).toContain("there are more");
  });

  it("reports has_more false when exactly a partial page comes back", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: { head: { vars: ["s"] }, results: { bindings: [{ s: { type: "literal", value: "only" } }] } },
      },
    ]);

    const result = await queryWikidataSparqlHandler({ query: "SELECT ?s WHERE { ?s ?p ?o }", limit: 5 }, fakeEnv());

    expect(result.structuredContent?.has_more).toBe(false);
    expect(result.structuredContent?.notice).toBe("");
  });
});

describe("#3 cache keys must stay inside Workers KV's 512-byte limit", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hashes a key that would otherwise overflow, and leaves a short one readable", async () => {
    const short = await cacheKey("wikimedia:meta:en.wikipedia.org:400", "Kiwi (bird)");
    expect(short).toBe("wikimedia:meta:en.wikipedia.org:400:Kiwi (bird)");

    const long = await cacheKey("wikimedia:meta:en.wikipedia.org:400", Array.from({ length: 50 }, () => "Kiwi (bird)").join("|"));
    expect(long).toMatch(/:sha256-[0-9a-f]{64}$/);
    expect(byteLength(long)).toBeLessThanOrEqual(512);
  });

  it("distinguishes different title sets after hashing", async () => {
    const a = await cacheKey("p", Array.from({ length: 50 }, (_, i) => `Title ${i} with padding text`).join("|"));
    const b = await cacheKey("p", Array.from({ length: 50 }, (_, i) => `Title ${i} with padding TEXT`).join("|"));
    expect(a).not.toBe(b);
  });

  it("survives a 50-title metadata call, which used to build a 635-byte key", async () => {
    // The fake cache now enforces the real 512-byte limit, so this test fails outright if the key
    // regresses — previously a plain Map hid it and the tool broke only in production.
    const titles = Array.from({ length: 50 }, () => "Kiwi (bird)").map((title, index) => `${title} ${index}`);
    stubFetchRoutes([{ match: anyUrl, body: { batchcomplete: true, query: { pages: [{ pageid: 1, ns: 0, title: "Kiwi (bird) 0" }] } } }]);

    const result = await getPageMetadataHandler({ titles }, fakeEnv());

    expect(result.isError).toBeUndefined();
  });

  it("the fake cache actually rejects an over-long key", async () => {
    const cache = createFakeCache();
    await expect(cache.get("x".repeat(513))).rejects.toThrow(/too long/);
  });
});

describe("#4 comment stripping must match the SPARQL grammar", () => {
  it("ends a comment at a carriage return, not only a newline", () => {
    // SPARQL 1.1 §19.4: a comment ends at 0x0D or 0x0A. Stopping only at \n let a \r-terminated
    // comment swallow the statement after it here while a real parser still executed it.
    expect(() => assertReadOnlySparql("SELECT ?s WHERE { ?s ?p ?o } # c\rINSERT DATA { wd:Q1 wdt:P1 wd:Q2 }")).toThrow(SparqlRejectedError);
    expect(stripSparqlComments("SELECT ?s # c\rWHERE { ?s ?p ?o }")).toBe("SELECT ?s \rWHERE { ?s ?p ?o }");
  });

  it("treats a top-level backslash escape as one token, not a comment start", () => {
    // `\#` is a legal PN_LOCAL_ESC inside a prefixed name (grammar rule 173).
    const query = "SELECT ?s WHERE { ?s ex:a\\#b ?o }";
    expect(stripSparqlComments(query)).toBe(query);
  });

  it("does not mistake a less-than operator for the start of an IRI", () => {
    // A bare `<` used to put the scanner into IRI mode until the next `>`, so a comment after a
    // numeric comparison was never stripped.
    const scrubbed = scrubSparqlLiterals("SELECT ?s WHERE { ?s ?p ?o FILTER(?o < 5) } # ADD a note\nORDER BY ?s");
    expect(scrubbed).not.toContain("ADD a note");
    expect(scrubbed).toContain("ORDER BY ?s");
  });
});

describe("#5 get_page cache key must agree with the fetch it caches", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an empty section rather than caching a lead extract under the full-article key", async () => {
    // `section: ""` was `!== undefined` (so an intro-only extract was fetched) but falsy (so the
    // key said "full"), poisoning whole-page reads for the whole TTL.
    const error = await getPageHandler({ title: "Kiwi (bird)", section: "" }, fakeEnv()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
  });

  it("caches intro and full extracts under different keys", async () => {
    const env = fakeEnv();
    const mock = stubFetchRoutes([
      { match: (url) => url.includes("prop=extracts"), body: { query: { pages: [{ pageid: 1, ns: 0, title: "Kiwi (bird)", extract: "Lead only." }] } } },
      { match: (url) => url.includes("prop=text"), body: { parse: { title: "Kiwi (bird)", text: "<p>Section.</p>" } } },
      { match: (url) => url.includes("prop=tocdata"), body: { parse: { tocdata: { sections: [] } } } },
    ]);

    await getPageHandler({ title: "Kiwi (bird)", section: "1" }, env);
    const whole = await getPageHandler({ title: "Kiwi (bird)" }, env);

    // The whole-page read must have gone upstream again rather than reusing the intro-only entry.
    expect(calledUrls(mock).filter((url) => url.searchParams.get("prop")?.includes("extracts")).length).toBe(2);
    expect(whole.structuredContent?.outline_only).toBe(false);
  });
});

describe("#6 Wikidata property URLs need the Property: namespace", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds Property:P31 for a property and a bare id for an item", () => {
    // Confirmed live: /wiki/P31 is a 404, /wiki/Property:P31 is a 200.
    expect(entityUrl("P31")).toBe("https://www.wikidata.org/wiki/Property:P31");
    expect(entityUrl("Q42")).toBe("https://www.wikidata.org/wiki/Q42");
  });

  it("search results for properties carry a live URL", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { search: [{ id: "P31", label: "instance of" }] } }]);

    const result = await searchEntitiesHandler({ query: "instance of", type: "property" }, fakeEnv());

    expect((result.structuredContent?.entities as Array<{ url: string }>)[0]?.url).toBe("https://www.wikidata.org/wiki/Property:P31");
  });

  it("get_entity for a property carries a live URL", async () => {
    stubFetchRoutes([
      { match: isRest, body: { id: "P31", statements: {} } },
      { match: isLabels, body: { entities: {} } },
    ]);

    const result = await getEntityHandler({ entity_id: "P31" }, fakeEnv());

    expect(result.structuredContent?.url).toBe("https://www.wikidata.org/wiki/Property:P31");
  });
});

describe("#7 the read-only guard must not reject ordinary queries", () => {
  it("allows update verbs that appear inside string literals", () => {
    // The keyword scan ran over raw text, so these were rejected for containing WITH / ADD.
    expect(() => assertReadOnlySparql('SELECT ?s WHERE { ?s rdfs:label ?l FILTER(CONTAINS(LCASE(?l), "with")) }')).not.toThrow();
    expect(() => assertReadOnlySparql('SELECT ?s WHERE { ?s rdfs:label "Add Vantage"@en }')).not.toThrow();
  });

  it("allows a variable or prefixed name that happens to spell an update verb", () => {
    expect(() => assertReadOnlySparql("SELECT ?add WHERE { ?add ?p ?o }")).not.toThrow();
    expect(() => assertReadOnlySparql("SELECT ?s WHERE { ?s ex:add ?o }")).not.toThrow();
  });

  it("still rejects a genuine update verb at statement position", () => {
    expect(() => assertReadOnlySparql("SELECT ?s WHERE { ?s ?p ?o } ; INSERT DATA { wd:Q1 wdt:P1 wd:Q2 }")).toThrow(SparqlRejectedError);
    expect(() => assertReadOnlySparql("WITH <http://g> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }")).toThrow(SparqlRejectedError);
  });
});

describe("#9 LIMIT detection must ignore string literals", () => {
  it("still injects a cap when the word limit only appears inside a literal", () => {
    const query = 'SELECT ?s WHERE { ?s rdfs:label ?l FILTER(CONTAINS(?l, "speed limit 50")) }';
    expect(applyRowLimit(query, 20)).toContain("LIMIT 21");
  });

  it("leaves a genuine LIMIT clause alone", () => {
    const query = "SELECT ?s WHERE { ?s ?p ?o } LIMIT 5";
    expect(applyRowLimit(query, 20)).toBe(query);
  });
});

describe("#10 categories must be attributed to the page they came from", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports the resolved title plus how the requested one was rewritten", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          batchcomplete: true,
          query: {
            normalized: [{ fromencoded: false, from: "kiwi bird", to: "Kiwi bird" }],
            redirects: [{ from: "Kiwi bird", to: "Kiwi (bird)" }],
            pages: [{ pageid: 17362, ns: 0, title: "Kiwi (bird)", categories: [{ ns: 14, title: "Category:Apteryx" }] }],
          },
        },
      },
    ]);

    const result = await getPageCategoriesHandler({ title: "kiwi bird" }, fakeEnv());

    expect(result.structuredContent?.title).toBe("Kiwi (bird)");
    expect(result.structuredContent?.normalized_from).toBe("kiwi bird");
    expect(result.structuredContent?.redirected_from).toBe("Kiwi bird");
  });
});

describe("#8 and #11 entity label batching and cache key", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("chunks label lookups instead of silently dropping everything past the 50-id cap", async () => {
    const statements: Record<string, unknown[]> = {};
    for (let index = 1; index <= 60; index++) {
      statements[`P${index}`] = [{ property: { id: `P${index}`, data_type: "wikibase-item" }, value: { type: "value", content: `Q${1000 + index}` } }];
    }
    const seenIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: Request | string | URL) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        if (url.pathname.includes("/rest.php/")) {
          return Promise.resolve(new Response(JSON.stringify({ id: "Q1", statements }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        const ids = (url.searchParams.get("ids") ?? "").split("|").filter(Boolean);
        expect(ids.length).toBeLessThanOrEqual(50);
        seenIds.push(...ids);
        const entities = Object.fromEntries(ids.map((id) => [id, { labels: { en: { value: `label-${id}` } } }]));
        return Promise.resolve(new Response(JSON.stringify({ entities }), { status: 200, headers: { "content-type": "application/json" } }));
      }),
    );

    const result = await getEntityHandler({ entity_id: "Q1", limit: 100 }, fakeEnv());

    // 60 properties + 60 referenced entities = 120 distinct ids, so three batches of <= 50.
    expect(seenIds.length).toBe(120);
    const rendered = result.structuredContent?.statements as Array<{ property_label?: string; value: string }>;
    expect(rendered.length).toBe(60);
    // Nothing falls back to a bare id — the promise the tool description makes.
    expect(rendered.every((statement) => statement.property_label !== undefined)).toBe(true);
    expect(rendered.every((statement) => statement.value.startsWith("label-"))).toBe(true);
  });

  it("reuses one cached entity across languages instead of storing a copy per language", async () => {
    const env = fakeEnv();
    const mock = stubFetchRoutes([
      { match: isRest, body: { id: "Q42", labels: { en: "Douglas Adams", fr: "Douglas Adams" }, statements: {} } },
      { match: isLabels, body: { entities: {} } },
    ]);

    await getEntityHandler({ entity_id: "Q42", language: "en" }, env);
    await getEntityHandler({ entity_id: "Q42", language: "fr" }, env);

    expect(calledUrls(mock).filter((url) => url.pathname.includes("/rest.php/")).length).toBe(1);
  });
});
