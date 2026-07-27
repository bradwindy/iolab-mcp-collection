import { z } from "zod";
import { attribution, jsonResult, limitParam, toolError, type ToolTextResult } from "@iolab/mcp-kit";
import {
  applyRowLimit,
  assertReadOnlySparql,
  runSparql,
  SPARQL_ENDPOINTS,
  SparqlRejectedError,
  SparqlSyntaxError,
  SparqlTimeoutError,
  type SparqlBinding,
} from "../clients/sparql.js";
import { mapCommonWikiError, attributionSchema } from "../toolSupport.js";

export const queryWikidataSparqlInputShape = {
  query: z
    .string()
    .min(1)
    .describe("A read-only SPARQL SELECT or ASK query. PREFIX declarations for wd:, wdt:, p:, ps:, rdfs: and friends are predeclared by the service."),
  graph: z
    .enum(["main", "scholarly"])
    .default("main")
    .describe(
      "Which Wikidata graph to query. These hold DIFFERENT data and querying the wrong one returns zero rows rather than an error: " +
        "'main' excludes every scholarly article (Q13442814) entirely, and 'scholarly' holds those ~45 million items and little else. " +
        "Use 'scholarly' for anything about academic papers, citations, or authorship; 'main' for everything else. " +
        "The split is by `instance of` alone, not by subject, so works about an academic topic can sit in either graph — " +
        "for a question that genuinely spans both, query 'main' and federate with " +
        "`SERVICE <https://query-scholarly.wikidata.org/sparql> { ... }`.",
    ),
  limit: limitParam(500, 100),
};

export const queryWikidataSparqlOutputShape = {
  /** Present for SELECT queries. Each row maps a variable name to its rendered value. */
  rows: z.array(z.record(z.string(), z.string())).optional(),
  /** Present for ASK queries instead of `rows`. */
  answer: z.boolean().optional(),
  columns: z.array(z.string()),
  graph: z.string(),
  /** The exact graph endpoint the query ran against, so a surprising empty result is traceable. */
  endpoint: z.string(),
  returned: z.number(),
  has_more: z.boolean(),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(queryWikidataSparqlInputShape);

/** Render a binding value, shortening entity URIs to the Q-id a caller can feed back into wikimedia_get_entity. */
function renderBinding(binding: SparqlBinding[string] | undefined): string {
  if (!binding?.value) return "";
  const entity = /^https?:\/\/www\.wikidata\.org\/entity\/([QP]\d+)$/.exec(binding.value);
  return entity?.[1] ?? binding.value;
}

export async function queryWikidataSparqlHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    assertReadOnlySparql(input.query);
  } catch (error) {
    if (error instanceof SparqlRejectedError) {
      return toolError(error.message, "Rewrite the query as a SELECT or ASK. This server is read-only.");
    }
    throw error;
  }

  try {
    const body = await runSparql(env, { query: applyRowLimit(input.query, input.limit), graph: input.graph });

    if (typeof body.boolean === "boolean") {
      return jsonResult({
        answer: body.boolean,
        columns: [],
        graph: input.graph,
        endpoint: SPARQL_ENDPOINTS[input.graph],
        returned: 1,
        has_more: false,
        notice: "",
        attribution: attribution("Wikidata Query Service", { license: "CC0 1.0", url: "https://query.wikidata.org/" }),
      });
    }

    const columns = body.head?.vars ?? [];
    const allBindings = body.results?.bindings ?? [];
    // `applyRowLimit` asks for `limit + 1` rows, so a full page plus one signals more behind it.
    // The slice is what actually enforces the cap — the injected LIMIT is skipped entirely for
    // queries that already carry one, or that use VALUES, so it can never be the only guard.
    const bindings = allBindings.slice(0, input.limit);
    const hasMore = allBindings.length > input.limit;

    const rows = bindings.map((binding) => {
      const row: Record<string, string> = {};
      for (const column of columns) row[column] = renderBinding(binding[column]);
      return row;
    });

    const notice: string[] = [];
    if (hasMore) {
      notice.push(`Showing the first ${bindings.length} matching rows; there are more. Raise \`limit\` or add a tighter filter.`);
    }
    if (rows.length === 0 && input.graph === "main") {
      notice.push(
        "No rows matched. If this query is about scholarly articles, papers, or citations, re-run it with `graph: \"scholarly\"` — " +
          "the main graph contains none of them.",
      );
    }

    return jsonResult({
      rows,
      columns,
      graph: input.graph,
      endpoint: SPARQL_ENDPOINTS[input.graph],
      returned: rows.length,
      has_more: hasMore,
      notice: notice.join(" "),
      attribution: attribution("Wikidata Query Service", { license: "CC0 1.0", url: "https://query.wikidata.org/" }),
    });
  } catch (error) {
    if (error instanceof SparqlTimeoutError) {
      return toolError(error.message, "Add a more selective triple pattern, restrict by type first, or lower `limit`.");
    }
    if (error instanceof SparqlSyntaxError) {
      // Explicitly NOT routed through the generic upstream path, whose advice is "this may be
      // transient; retry" — a malformed query fails identically every time.
      return toolError(error.message, "Fix the syntax at the position reported above and call again. Do not retry the query unchanged.");
    }
    const mapped = mapCommonWikiError(error, "Check the SPARQL syntax; the service returns an error page for a malformed query.");
    if (mapped) return mapped;
    throw error;
  }
}
