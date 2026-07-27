import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRowLimit, assertReadOnlySparql, SparqlRejectedError, stripSparqlComments } from "../src/clients/sparql.js";
import { queryWikidataSparqlHandler } from "../src/tools/queryWikidataSparql.js";
import { calledUrls, fakeEnv, stubFetchRoutes } from "./support/fakeEnv.js";

const anyUrl = () => true;

describe("stripSparqlComments", () => {
  it("removes a real comment", () => {
    expect(stripSparqlComments("SELECT ?s # a comment\nWHERE { ?s ?p ?o }")).toBe("SELECT ?s \nWHERE { ?s ?p ?o }");
  });

  it("leaves a # inside an IRI alone", () => {
    // A naive /#.*$/gm would truncate the IRI here and silently change what the query means.
    const query = "SELECT ?s WHERE { ?s <http://example.org/ns#label> ?o }";
    expect(stripSparqlComments(query)).toBe(query);
  });

  it("leaves a # inside a string literal alone", () => {
    const query = 'SELECT ?s WHERE { ?s rdfs:label "tag #1" }';
    expect(stripSparqlComments(query)).toBe(query);
  });

  it("handles triple-quoted literals and escaped quotes", () => {
    const query = 'SELECT ?s WHERE { ?s rdfs:label """a # b""" ; skos:note "say \\"hi\\" #x" }';
    expect(stripSparqlComments(query)).toBe(query);
  });
});

describe("assertReadOnlySparql", () => {
  it("accepts a plain SELECT and a plain ASK", () => {
    expect(() => assertReadOnlySparql("SELECT ?s WHERE { ?s ?p ?o }")).not.toThrow();
    expect(() => assertReadOnlySparql("ASK { wd:Q42 wdt:P31 wd:Q5 }")).not.toThrow();
  });

  it("accepts a SELECT behind BASE and PREFIX declarations", () => {
    expect(() =>
      assertReadOnlySparql("PREFIX wd: <http://www.wikidata.org/entity/>\nPREFIX wdt: <http://www.wikidata.org/prop/direct/>\nSELECT ?s WHERE { ?s wdt:P31 wd:Q5 }"),
    ).not.toThrow();
  });

  it("rejects an update operation", () => {
    expect(() => assertReadOnlySparql("INSERT DATA { wd:Q1 wdt:P1 wd:Q2 }")).toThrow(SparqlRejectedError);
    expect(() => assertReadOnlySparql("DELETE WHERE { ?s ?p ?o }")).toThrow(SparqlRejectedError);
    expect(() => assertReadOnlySparql("DROP GRAPH <http://example.org/g>")).toThrow(SparqlRejectedError);
  });

  it("cannot be bypassed by chaining an update after a leading SELECT", () => {
    // The SPARQL analogue of SQL statement chaining: a form check that only looks at the first
    // keyword would wave this through. The repo's tool-design checklist names this exact failure.
    expect(() => assertReadOnlySparql("SELECT ?s WHERE { ?s ?p ?o }; DELETE WHERE { ?s ?p ?o }")).toThrow(SparqlRejectedError);
  });

  it("cannot be bypassed by hiding the real form behind a comment", () => {
    expect(() => assertReadOnlySparql("# SELECT ?s\nINSERT DATA { wd:Q1 wdt:P1 wd:Q2 }")).toThrow(SparqlRejectedError);
  });

  it("rejects CONSTRUCT and DESCRIBE, which return a graph this server cannot render", () => {
    expect(() => assertReadOnlySparql("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }")).toThrow(SparqlRejectedError);
    expect(() => assertReadOnlySparql("DESCRIBE wd:Q42")).toThrow(SparqlRejectedError);
  });

  it("rejects a query that is empty once comments are removed", () => {
    expect(() => assertReadOnlySparql("# nothing here\n")).toThrow(SparqlRejectedError);
  });
});

describe("applyRowLimit", () => {
  it("appends a LIMIT one larger than the page, as the has-more probe", () => {
    expect(applyRowLimit("SELECT ?s WHERE { ?s ?p ?o }", 50)).toBe("SELECT ?s WHERE { ?s ?p ?o }\nLIMIT 51");
  });

  it("leaves an existing LIMIT alone", () => {
    const query = "SELECT ?s WHERE { ?s ?p ?o } LIMIT 5";
    expect(applyRowLimit(query, 50)).toBe(query);
  });

  it("never appends a LIMIT to an ASK, which does not accept one", () => {
    const query = "ASK { wd:Q42 wdt:P31 wd:Q5 }";
    expect(applyRowLimit(query, 50)).toBe(query);
  });

  it("is not fooled by the word LIMIT inside a comment", () => {
    const result = applyRowLimit("SELECT ?s WHERE { ?s ?p ?o } # LIMIT 5\n", 50);
    expect(result.trimEnd().endsWith("LIMIT 51")).toBe(true);
  });
});

describe("wikimedia_query_wikidata_sparql", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("queries the scholarly endpoint when asked, and the main one by default", async () => {
    // The reason this parameter exists. Confirmed live, counting scholarly articles (Q13442814):
    // query.wikidata.org returns 0 while query-scholarly.wikidata.org returns ~45.7 million.
    const main = stubFetchRoutes([{ match: anyUrl, body: { head: { vars: ["c"] }, results: { bindings: [] } } }]);
    await queryWikidataSparqlHandler({ query: "SELECT (COUNT(*) AS ?c) WHERE { ?s wdt:P31 wd:Q13442814 }" }, fakeEnv());
    expect((calledUrls(main)[0] as URL).host).toBe("query.wikidata.org");

    vi.unstubAllGlobals();
    const scholarly = stubFetchRoutes([{ match: anyUrl, body: { head: { vars: ["c"] }, results: { bindings: [] } } }]);
    const result = await queryWikidataSparqlHandler(
      { query: "SELECT (COUNT(*) AS ?c) WHERE { ?s wdt:P31 wd:Q13442814 }", graph: "scholarly" },
      fakeEnv(),
    );
    expect((calledUrls(scholarly)[0] as URL).host).toBe("query-scholarly.wikidata.org");
    expect(result.structuredContent?.endpoint).toBe("https://query-scholarly.wikidata.org/sparql");
  });

  it("tells the caller about the scholarly graph when a main-graph query returns nothing", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { head: { vars: ["s"] }, results: { bindings: [] } } }]);

    const result = await queryWikidataSparqlHandler({ query: "SELECT ?s WHERE { ?s wdt:P31 wd:Q13442814 }" }, fakeEnv());

    expect(result.structuredContent?.rows).toEqual([]);
    expect(result.structuredContent?.notice).toContain('graph: "scholarly"');
  });

  it("shortens entity URIs to the Q-id that feeds back into wikimedia_get_entity", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          head: { vars: ["item", "label"] },
          results: {
            bindings: [
              {
                item: { type: "uri", value: "http://www.wikidata.org/entity/Q43642" },
                label: { type: "literal", value: "Apteryx", "xml:lang": "en" },
              },
            ],
          },
        },
      },
    ]);

    const result = await queryWikidataSparqlHandler({ query: "SELECT ?item ?label WHERE { ?item wdt:P31 wd:Q16521 }" }, fakeEnv());

    expect(result.structuredContent?.columns).toEqual(["item", "label"]);
    expect(result.structuredContent?.rows).toEqual([{ item: "Q43642", label: "Apteryx" }]);
  });

  it("returns an ASK result as a boolean answer rather than rows", async () => {
    stubFetchRoutes([{ match: anyUrl, body: { head: {}, boolean: true } }]);

    const result = await queryWikidataSparqlHandler({ query: "ASK { wd:Q42 wdt:P31 wd:Q5 }" }, fakeEnv());

    expect(result.structuredContent?.answer).toBe(true);
    expect(result.structuredContent?.rows).toBeUndefined();
  });

  it("caps rows even when the caller supplied their own larger LIMIT", async () => {
    stubFetchRoutes([
      {
        match: anyUrl,
        body: {
          head: { vars: ["s"] },
          results: { bindings: Array.from({ length: 10 }, (_, index) => ({ s: { type: "literal", value: `row-${index}` } })) },
        },
      },
    ]);

    const result = await queryWikidataSparqlHandler({ query: "SELECT ?s WHERE { ?s ?p ?o } LIMIT 1000", limit: 3 }, fakeEnv());

    expect((result.structuredContent?.rows as unknown[]).length).toBe(3);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.notice).toContain("Showing the first 3 matching rows");
  });

  it("rejects a write query without calling the service at all", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, body: {} }]);

    const result = await queryWikidataSparqlHandler({ query: "INSERT DATA { wd:Q1 wdt:P1 wd:Q2 }" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("read-only");
    expect(mock).not.toHaveBeenCalled();
  });

  it("distinguishes the 60-second query timeout from a generic server error", async () => {
    // WDQS reports a timeout as a 500 carrying a Java trace, which is otherwise indistinguishable
    // from a real fault.
    stubFetchRoutes([{ match: anyUrl, text: "java.util.concurrent.TimeoutException: query timed out", status: 500 }]);

    const result = await queryWikidataSparqlHandler({ query: "SELECT ?s WHERE { ?s ?p ?o }" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("60-second");
    expect(result.content[0]?.text).toContain("selective");
  });

  it("reports a genuine server error as an upstream failure", async () => {
    stubFetchRoutes([{ match: anyUrl, text: "Internal Server Error", status: 500 }]);

    const result = await queryWikidataSparqlHandler({ query: "SELECT ?s WHERE { ?s ?p ?o }" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("500");
  });

  it("recognises a 504 as the timeout it actually is", async () => {
    // The 500-with-a-Java-trace case above could not be reproduced live at all. What WDQS really
    // returns for an aggregate query past the deadline is HTTP 504, text/plain "upstream request
    // timeout", at ~65.5s — so checking only for 500 left SparqlTimeoutError unreachable.
    stubFetchRoutes([{ match: anyUrl, text: "upstream request timeout", status: 504 }]);

    const result = await queryWikidataSparqlHandler({ query: "SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o }" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("60-second");
    expect(result.content[0]?.text).toContain("selective");
  });

  it("recognises a truncated 200 body with a timeout trace appended", async () => {
    // The streaming case: a SELECT that outruns the deadline returns HTTP 200 with
    // content-type: application/sparql-results+json, cut off mid-token, with the Java trace tacked
    // on. Measured live at 1,684,247,442 bytes — `await response.json()` on that is an OOM kill in a
    // 128 MB Worker rather than an error message.
    stubFetchRoutes([
      {
        match: anyUrl,
        text: '{"head":{"vars":["a"]},"results":{"bindings":[{"a":{"type":"uri","value":"http://www.wikjava.util.concurrent.TimeoutException\n\tat java.util.concurrent.FutureTask.get(FutureTask.java:205)',
        status: 200,
      },
    ]);

    const result = await queryWikidataSparqlHandler({ query: "SELECT ?a ?b WHERE { ?a wdt:P31 ?b }" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("60-second");
  });

  it("surfaces the parser's own message for a syntax error and says not to retry", async () => {
    // A 400 previously fell through to the generic upstream path, whose advice is "this may be
    // transient; retry" — for a query that is malformed and will fail identically every time.
    stubFetchRoutes([
      {
        match: anyUrl,
        text:
          "SPARQL-QUERY: queryStr=SELECT ?x WHERE { ?x wdt:P31 wd:Q5 \n" +
          'java.util.concurrent.ExecutionException: org.openrdf.query.MalformedQueryException: Encountered "<EOF>" at line 1, column 35.\n' +
          "\tat java.util.concurrent.FutureTask.report(FutureTask.java:122)\n\tat java.util.concurrent.FutureTask.get(FutureTask.java:206)",
        status: 400,
      },
    ]);

    const result = await queryWikidataSparqlHandler({ query: "SELECT ?x WHERE { ?x wdt:P31 wd:Q5" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("line 1, column 35");
    expect(result.content[0]?.text).toContain("Do not retry");
    // The forty frames of Java stack trace are not something a caller can act on.
    expect(result.content[0]?.text).not.toContain("FutureTask");
    expect(result.content[0]?.text).not.toContain("transient");
  });

  it("does not retry a 504, which would re-run a query already known to be too slow", async () => {
    const mock = stubFetchRoutes([{ match: anyUrl, text: "upstream request timeout", status: 504 }]);

    await queryWikidataSparqlHandler({ query: "SELECT ?s WHERE { ?s ?p ?o }" }, fakeEnv());

    expect(mock).toHaveBeenCalledTimes(1);
  });
});
