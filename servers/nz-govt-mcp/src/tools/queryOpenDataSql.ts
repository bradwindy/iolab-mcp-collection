import { z } from "zod";
import {
  attribution,
  cached,
  CACHE_TTL,
  jsonResult,
  toolError,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import {
  ckanCacheKey,
  datastoreSearchSql,
  SqlValidationError,
  UpstreamActionError,
  UpstreamFetchError,
} from "../clients/datagovt.js";

const MAX_ROWS_RETURNED = 200;

export const queryOpenDataSqlInputShape = {
  sql: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "A read-only SELECT statement against data.govt.nz's datastore. Reference a resource by quoting its " +
        `id as the table name, e.g. SELECT "Org_Name" FROM "4b292323-9fcc-41f8-814b-3c7b19cf14b3" LIMIT 10. ` +
        "Find resource ids with nz_govt_get_dataset. Only works against datastore-enabled resources.",
    ),
};

export const queryOpenDataSqlOutputShape = {
  rows: z.array(z.record(z.string(), z.unknown())),
  row_count: z.number(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(queryOpenDataSqlInputShape);

export async function queryOpenDataSqlHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const cacheKey = await ckanCacheKey("datastore_search_sql", { sql: input.sql });
    const { records } = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.SLOW_MOVING, () => datastoreSearchSql(input.sql));
    const truncated = records.length > MAX_ROWS_RETURNED;
    const rows = truncated ? records.slice(0, MAX_ROWS_RETURNED) : records;

    return jsonResult({
      rows,
      row_count: rows.length,
      notice: truncated
        ? `Showing the first ${MAX_ROWS_RETURNED} of ${records.length} rows. Add a LIMIT clause to your SQL to control this directly.`
        : "",
      attribution: attribution("data.govt.nz datastore", { url: "https://catalogue.data.govt.nz/" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    if (error instanceof SqlValidationError) return toolError(error.message);
    if (error instanceof UpstreamActionError) {
      return toolError(
        error.message,
        "This is data.govt.nz's own error (e.g. a malformed query or a resource id that isn't datastore-enabled), not a network failure — verify the resource with nz_govt_get_dataset and check the SQL syntax.",
      );
    }
    if (error instanceof UpstreamFetchError) {
      return toolError(error.message, "This looks like a transient network issue reaching data.govt.nz; retry in a moment.");
    }
    throw error;
  }
}
