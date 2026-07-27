import { UpstreamHttpError } from "@iolab/mcp-kit";
import { wikimediaFetch } from "./http.js";

export const SOURCE = "Wikidata Query Service";

/**
 * The Wikidata Query Service was split into two disjoint graphs. This is not a performance tier —
 * they hold different data, and querying the wrong one returns an empty result set rather than an
 * error.
 *
 * Confirmed live (2026-07-27), counting `?s wdt:P31 wd:Q13442814` (scholarly article):
 *   query.wikidata.org           ->          0
 *   query-scholarly.wikidata.org -> 45,685,285
 *
 * The split was executed 9 May 2025 and re-merging is not planned
 * (https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/WDQS_graph_split). A tool that only
 * ever hit the default endpoint would silently return nothing for roughly a third of Wikidata.
 *
 * Membership is decided by `P31`/`P13046` alone, so the division is **not** by subject matter. A
 * work carrying a subject-matter property such as `P921` can legitimately live in either graph —
 * confirmed live, `?work wdt:P921 wd:Q43642` returns rows on both, with the main graph holding
 * encyclopedia articles (Q13433827), articles (Q191067) and editions (Q3331189). For a question
 * genuinely spanning both, federate from main with
 * `SERVICE <https://query-scholarly.wikidata.org/sparql> { ... }`, which is supported and works.
 * `query-legacy-full.wikidata.org` no longer resolves, so there is no full-graph endpoint left.
 */
export const SPARQL_ENDPOINTS = {
  main: "https://query.wikidata.org/sparql",
  scholarly: "https://query-scholarly.wikidata.org/sparql",
} as const;

export type SparqlGraph = keyof typeof SPARQL_ENDPOINTS;

export class SparqlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SparqlRejectedError";
  }
}

/**
 * SPARQL 1.1 Update keywords, plus the two read forms this server cannot render.
 *
 * WDQS exposes no update endpoint, so this is defence in depth rather than the only thing standing
 * between a caller and a write. `DESCRIBE`/`CONSTRUCT` are refused for a different reason: they
 * return an RDF graph rather than a result table, which nothing downstream can format.
 */
const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "DELETE",
  "LOAD",
  "CLEAR",
  "CREATE",
  "DROP",
  "COPY",
  "MOVE",
  "ADD",
  "WITH",
  "CONSTRUCT",
  "DESCRIBE",
];

/**
 * Remove SPARQL comments without corrupting the query.
 *
 * A naive `/#.*$/gm` is wrong: `#` is legal inside IRIs (`<http://example.org/#frag>`) and inside
 * string literals, and stripping from there would silently truncate the query into something that
 * still parses but means something else. This scans instead, tracking IRI and literal state
 * (including the triple-quoted forms) so only a genuine comment `#` is removed.
 */
export function stripSparqlComments(query: string): string {
  return scanSparql(query).stripped;
}

/**
 * Strip comments AND blank out the *contents* of string literals and IRIs, keeping their delimiters.
 *
 * This is what the read-only guard and the LIMIT detection actually scan, because searching the raw
 * query text conflates code with data. Without it, `FILTER(CONTAINS(?label, "with"))` is rejected
 * for containing the SPARQL Update verb `WITH`, and `FILTER(CONTAINS(?l, "speed limit 50"))` is read
 * as already carrying a LIMIT clause so no row cap gets injected.
 */
export function scrubSparqlLiterals(query: string): string {
  return scanSparql(query).scrubbed;
}

/** An IRIREF per SPARQL 1.1 grammar rule 139: no whitespace or these delimiters may appear inside. */
const IRIREF = /^<[^\s<>"{}|^`\\]*>/;

function scanSparql(query: string): { stripped: string; scrubbed: string } {
  let stripped = "";
  let scrubbed = "";
  let index = 0;
  let quote: string | null = null;

  const emit = (text: string, blank: string = text) => {
    stripped += text;
    scrubbed += blank;
  };

  while (index < query.length) {
    const char = query[index] as string;

    if (quote !== null) {
      if (char === "\\") {
        emit(char + (query[index + 1] ?? ""), "  ");
        index += 2;
        continue;
      }
      if (query.startsWith(quote, index)) {
        emit(quote);
        index += quote.length;
        quote = null;
        continue;
      }
      // Blank the literal's content but keep newlines, so line-based reasoning stays aligned.
      emit(char, char === "\n" || char === "\r" ? char : " ");
      index += 1;
      continue;
    }

    if (char === "<") {
      // Only treat this as an IRI if it actually parses as one. A bare `<` is the less-than
      // operator (`FILTER(?o < 5)`), and treating it as opening an IRI would swallow everything up
      // to the next `>` — including any comment inside, which then never gets stripped.
      const iri = IRIREF.exec(query.slice(index));
      if (iri) {
        const text = iri[0];
        emit(text, `<${" ".repeat(text.length - 2)}>`);
        index += text.length;
        continue;
      }
      emit(char);
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const triple = char.repeat(3);
      quote = query.startsWith(triple, index) ? triple : char;
      emit(quote);
      index += quote.length;
      continue;
    }

    // A backslash outside a literal is SPARQL's PN_LOCAL_ESC (grammar rule 173): `\#` is a legal
    // escaped `#` inside a prefixed name's local part, NOT the start of a comment. Copying both
    // characters keeps a stripper-visible `#` from diverging from what a real parser sees.
    if (char === "\\") {
      emit(char + (query[index + 1] ?? ""));
      index += 2;
      continue;
    }

    if (char === "#") {
      // A comment runs to the next line terminator, and per SPARQL 1.1 §19.4 that is 0x0D **or**
      // 0x0A — not just \n. Stopping only at \n would let a \r-terminated comment swallow the
      // statement that follows it here while a real parser still executes it, which is precisely
      // how a read-only guard built on this gets bypassed.
      const terminator = /[\r\n]/.exec(query.slice(index));
      if (!terminator) break;
      // Keep the terminator so token boundaries either side of the comment survive.
      const terminatorIndex = index + (terminator.index as number);
      emit(query[terminatorIndex] as string);
      index = terminatorIndex + 1;
      continue;
    }

    emit(char);
    index += 1;
  }

  return { stripped, scrubbed };
}

/** Leading `BASE <iri>` / `PREFIX pfx: <iri>` declarations, which precede the real query form. */
const PROLOGUE = /^(?:\s*(?:BASE\s*<[^>]*>|PREFIX\s+[^\s:]*:\s*<[^>]*>))*\s*/i;

/**
 * Reject anything that is not a read-only SELECT/ASK.
 *
 * Two independent checks, because either alone is bypassable. Matching the *first* query form after
 * the prologue stops a leading `SELECT` from vouching for whatever follows it (the SPARQL analogue
 * of SQL statement chaining), and the whole-word keyword scan catches an update verb buried deeper
 * in the query where a form check would never look. An anchored prefix regex on its own — the
 * pattern this repo's tool-design checklist explicitly calls out as insufficient — would pass both.
 */
export function assertReadOnlySparql(query: string): void {
  // Scanned with literal and IRI contents blanked out, so the keyword check reasons about code
  // rather than data. `FILTER(CONTAINS(?label, "with"))` is a perfectly ordinary query and must not
  // be rejected for the SPARQL Update verb hiding inside its search string.
  const scrubbed = scrubSparqlLiterals(query);

  if (scrubbed.trim().length === 0) {
    throw new SparqlRejectedError("The query is empty once comments are removed.");
  }

  for (const keyword of FORBIDDEN_KEYWORDS) {
    // The lookbehind excludes `?add` / `$add` (variable names) and `ex:add` (prefixed names), where
    // these words are identifiers rather than operations. A real update verb sits at statement
    // position, preceded by whitespace or a separator, so it still matches.
    if (new RegExp(`(?<![?$:\\w])${keyword}\\b`, "i").test(scrubbed)) {
      // "anywhere in the query" overstated what this does and read as a bug when a caller found
      // that `VALUES ?s { "DELETE" }` runs fine. It does, deliberately: the scan is over `scrubbed`,
      // with literal and IRI contents and comments already blanked out, so only a keyword in
      // executable position is rejected.
      throw new SparqlRejectedError(
        `This tool only runs read-only SELECT or ASK queries; '${keyword}' appears as query syntax. ` +
          `The same word inside a string literal or a comment is fine.`,
      );
    }
  }

  // Skip the prologue (any number of BASE <iri> / PREFIX pfx: <iri> declarations) and look at the
  // first real keyword. Anything that isn't SELECT or ASK is refused.
  //
  // The `*` quantifier has to be on the group rather than on the whole regex with /g: an anchored
  // /g replace only ever matches at index 0, so it would strip one PREFIX and leave the rest,
  // making a perfectly ordinary multi-prefix query look like it "starts with PREFIX".
  const withoutPrologue = scrubbed.replace(PROLOGUE, "");
  const firstKeyword = /^\s*([A-Za-z]+)/.exec(withoutPrologue)?.[1]?.toUpperCase();
  if (firstKeyword !== "SELECT" && firstKeyword !== "ASK") {
    throw new SparqlRejectedError(
      `This tool only runs read-only SELECT or ASK queries; the query starts with '${firstKeyword ?? "nothing recognisable"}'.`,
    );
  }
}

/**
 * Append a LIMIT when the caller did not supply one, so a broad query can't stream back millions of
 * rows. One more than `limit` is requested so the caller can tell "exactly a full page" from "a full
 * page and more behind it" without a second query.
 *
 * Injection is skipped, not attempted-and-hoped, in three cases:
 *
 * - **ASK** returns a single boolean and rejects a LIMIT clause outright.
 * - **The query already has a LIMIT.** Note this also matches a LIMIT that only exists inside a
 *   subquery, so an outer query can occasionally go uncapped — deliberately erring towards not
 *   corrupting a valid query, since the row cap is enforced again client-side regardless.
 * - **The query mentions VALUES.** SPARQL's grammar puts `ValuesClause` *after* `SolutionModifier`
 *   (rules 7 and 8), so a trailing `VALUES ?s { ... }` makes an appended LIMIT a syntax error —
 *   confirmed live, the identical query returns 200 without the injection and 400 with it, and the
 *   caller would then be told to check syntax they had written correctly. Deciding whether a given
 *   VALUES is the trailing one needs a real parser, so any VALUES suppresses injection.
 */
export function applyRowLimit(query: string, limit: number): string {
  // Scrubbed, not merely comment-stripped: `FILTER(CONTAINS(?l, "speed limit 50"))` would otherwise
  // read as an existing LIMIT clause and leave the query uncapped upstream.
  const scrubbed = scrubSparqlLiterals(query);
  if (/\bLIMIT\s+\d+/i.test(scrubbed)) return query;
  if (/\bVALUES\b/i.test(scrubbed)) return query;
  if (/^ASK\b/i.test(scrubbed.replace(PROLOGUE, ""))) return query;
  return `${query.trimEnd()}\nLIMIT ${limit + 1}`;
}

export type SparqlBinding = Record<string, { type?: string; value?: string; datatype?: string; "xml:lang"?: string }>;

export type SparqlResponse = {
  head?: { vars?: string[] };
  results?: { bindings?: SparqlBinding[] };
  boolean?: boolean;
};

export class SparqlTimeoutError extends Error {
  constructor() {
    super("The query exceeded the Wikidata Query Service's 60-second execution limit.");
    this.name = "SparqlTimeoutError";
  }
}

/** A malformed query. Deterministic — retrying it is guaranteed to fail the same way. */
export class SparqlSyntaxError extends Error {
  constructor(readonly detail: string) {
    super(detail.length > 0 ? `The Wikidata Query Service rejected the query as malformed: ${detail}` : "The Wikidata Query Service rejected the query as malformed.");
    this.name = "SparqlSyntaxError";
  }
}

/**
 * Hard ceiling on the response body.
 *
 * A SPARQL result set that answers a sensible question is kilobytes. This exists for the case
 * below, where the service streams until it times out: measured live, a `SELECT ?a ?b WHERE { ?a
 * wdt:P31 ?b }` returned **1,684,247,442 bytes** with HTTP 200 before being cut off mid-token.
 * `await response.json()` on that is an out-of-memory kill in a 128 MB Worker, not an error message.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Enough of the tail to catch a Java trace appended after a truncated result set. */
const TIMEOUT_TRACE = /TimeoutException|QueryTimeout/i;

export async function runSparql(env: Env, params: { query: string; graph: SparqlGraph }): Promise<SparqlResponse> {
  const url = new URL(SPARQL_ENDPOINTS[params.graph]);
  url.searchParams.set("query", params.query);
  url.searchParams.set("format", "json");

  const response = await wikimediaFetch(
    env,
    url,
    { headers: { Accept: "application/sparql-results+json" } },
    {
      // 500 and 504 are deliberately excluded from the retry set here, unlike everywhere else in
      // this server: both are how WDQS reports a query that blew its 60-second ceiling, and the
      // default policy would re-run that same expensive query up to two more times — three minutes
      // of load for a query already known to be too slow.
      retryOn: (candidate) => candidate === undefined || candidate.status === 429 || candidate.status === 503,
    },
  );

  // A query that exceeds the 60-second deadline reports itself three different ways, and the
  // obvious one — HTTP 500 — is the one that could not be reproduced at all. Measured live:
  //   aggregate query   -> HTTP 504, text/plain "upstream request timeout", at ~65.5s
  //   streaming SELECT  -> HTTP 200, a truncated JSON body with a TimeoutException trace appended
  // Checking only for 500, as this once did, left SparqlTimeoutError unreachable and sent the 200
  // case straight into an unbounded JSON parse.
  if (response.status === 504) throw new SparqlTimeoutError();
  if (response.status === 500) {
    const body = await readCapped(response);
    if (TIMEOUT_TRACE.test(body)) throw new SparqlTimeoutError();
    throw new UpstreamHttpError(SOURCE, response);
  }
  if (response.status === 400) {
    throw new SparqlSyntaxError(parseMalformedQuery(await readCapped(response)));
  }
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const body = await readCapped(response);
  try {
    return JSON.parse(body) as SparqlResponse;
  } catch {
    // A body that is not JSON at this point is a result set truncated mid-token by the deadline.
    if (TIMEOUT_TRACE.test(body)) throw new SparqlTimeoutError();
    throw new UpstreamHttpError(SOURCE, response);
  }
}

/**
 * Read a response body, refusing to buffer more than `MAX_RESPONSE_BYTES`.
 *
 * `response.text()` would happily accumulate the whole 1.6 GB. Reading the stream and stopping lets
 * the truncated prefix still be inspected for a timeout trace.
 */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= MAX_RESPONSE_BYTES) {
        // Everything past the cap is discarded; the tail carries the trace when there is one.
        text += decoder.decode();
        return text;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text + decoder.decode();
}

/**
 * Pull the useful line out of a Blazegraph parser error, discarding the Java stack trace.
 *
 * A live 400 body is a `MalformedQueryException` naming the offending token and position, followed
 * by ~40 frames of `java.util.concurrent...` that say nothing a caller can act on.
 */
export function parseMalformedQuery(body: string): string {
  const encountered = /Encountered\s+.*?at line \d+, column \d+\./s.exec(body);
  if (encountered !== null) return encountered[0].replace(/\s+/g, " ").trim();
  const malformed = /MalformedQueryException:\s*(.+)/.exec(body);
  if (malformed !== null) return (malformed[1] as string).split("\n")[0]?.trim() ?? "";
  return "";
}
