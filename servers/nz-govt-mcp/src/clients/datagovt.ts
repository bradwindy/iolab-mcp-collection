import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://catalogue.data.govt.nz/api/3/action";
const SOURCE = "data.govt.nz";
const USER_AGENT = "nz-mcp-collection/nz-govt-mcp (+https://github.com/bradwindy/nz-mcp-collection)";

/** Thrown by datastoreSearchSql's input guard — always a caller-actionable message. */
export class SqlValidationError extends Error {}

/**
 * Thrown when CKAN's action API responds 2xx but its own `{success: false}` envelope reports a
 * failure — a malformed SQL query, a resource that isn't datastore-enabled, an invalid filter,
 * etc. Distinct from UpstreamHttpError (a non-2xx HTTP status): there's no bad status to report
 * here, only CKAN's own error message. Every tool handler that calls into this client must catch
 * it alongside UpstreamHttpError — previously only UpstreamHttpError was caught, so this case
 * fell through as an unformatted, unlogged exception (confirmed as the cause of "server error on
 * every call" reports for search_datasets/get_dataset/query_open_data_sql/search_schools/
 * search_early_childhood_services, all five of which share this client).
 */
export class UpstreamActionError extends Error {
  constructor(
    public readonly source: string,
    public readonly action: string,
    public readonly ckanMessage: string,
  ) {
    super(`${source} action '${action}' failed: ${ckanMessage}`);
    this.name = "UpstreamActionError";
  }
}

export type CkanResource = {
  id: string;
  name: string | null;
  format: string | null;
  url: string;
  datastore_active: boolean;
};

export type CkanPackage = {
  id: string;
  name: string;
  title: string;
  notes: string | null;
  organization: { name: string; title: string } | null;
  license_title: string | null;
  license_url: string | null;
  metadata_modified: string;
  num_resources: number;
  resources: CkanResource[];
  tags: Array<{ name: string }>;
};

type CkanResponse<T> = {
  success: boolean;
  result: T;
  error?: { message: string };
};

async function callAction<T>(action: string, query: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}/${action}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  console.log(`[datagovt] ${action} request:`, url.toString());

  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) {
    console.error(
      `[datagovt] ${action} upstream HTTP error:`,
      `status=${response.status} ${response.statusText}`,
      `url=${url.toString()}`,
    );
    throw new UpstreamHttpError(SOURCE, response);
  }

  const body = (await response.json()) as CkanResponse<T>;
  if (!body.success) {
    const message = body.error?.message ?? "unknown error";
    console.error(`[datagovt] ${action} CKAN reported failure:`, message, `url=${url.toString()}`);
    throw new UpstreamActionError(SOURCE, action, message);
  }

  console.log(`[datagovt] ${action} succeeded.`);
  return body.result;
}

export async function searchDatasets(params: {
  query: string;
  rows: number;
  start: number;
}): Promise<{ count: number; results: CkanPackage[] }> {
  return callAction("package_search", {
    q: params.query,
    rows: String(params.rows),
    start: String(params.start),
    // CKAN's own default is "score desc, metadata_modified desc" — reproduced explicitly here
    // plus a `name asc` tiebreak, so two datasets tied on both score and modified timestamp
    // (common for a batch import) still paginate deterministically instead of relying on
    // Solr's undocumented tie-break order.
    sort: "score desc, metadata_modified desc, name asc",
  });
}

export async function getDataset(idOrSlug: string): Promise<CkanPackage> {
  return callAction("package_show", { id: idOrSlug });
}

export type DatastoreRecord = Record<string, string | number | boolean | null>;

export async function datastoreSearch(params: {
  resourceId: string;
  query?: string;
  filters?: Record<string, string>;
  limit: number;
  offset: number;
}): Promise<{ total: number; records: DatastoreRecord[] }> {
  const query: Record<string, string> = {
    resource_id: params.resourceId,
    limit: String(params.limit),
    offset: String(params.offset),
    // CKAN's datastore_search gives NO ordering guarantee for LIMIT/OFFSET without an explicit
    // `sort` — confirmed live: the same paginated query re-run with an unchanged offset can
    // return a different slice of rows, which silently duplicates some records across pages and
    // drops others entirely. `_id` is the datastore's always-present internal primary key, so
    // it's a safe, stable tiebreak for every resource regardless of whether `q` is also set.
    //
    // Trade-off, deliberately accepted: when `q` is set, this discards CKAN's implicit
    // relevance ordering (confirmed live — `sort=rank`/`sort=rank desc` is rejected as an
    // invalid sort value, so relevance can't be combined with a stable tiebreak the way
    // `score desc, name asc` works for `searchDatasets` above). A broad single-word `q` can
    // therefore return its best match outside the first page. Correctness wins here: the
    // alternative (no explicit sort when `q` is set) reproduces the exact bug this fixes —
    // confirmed live for `q=Canterbury`, where many rows tie on relevance and Postgres' tie-break
    // order for LIMIT/OFFSET is undefined, silently corrupting counts across pages. A broad
    // free-text search still surfaces `total_count`/the truncation notice so a caller can narrow
    // further; a silently incomplete or duplicated result set gives no such signal.
    sort: "_id",
  };
  if (params.query) query.q = params.query;
  if (params.filters) query.filters = JSON.stringify(params.filters);

  const result = await callAction<{ total: number; records: DatastoreRecord[] }>("datastore_search", query);
  return result;
}

const SELECT_ONLY = /^\s*select\b/i;

/**
 * Raw SQL escape hatch over CKAN's datastore_search_sql, restricted to read-only
 * SELECT statements. This proxies an already-public, unauthenticated government
 * endpoint — it grants no privilege the caller didn't already have. The SELECT_ONLY
 * check alone only anchors the *start* of the string, so a payload like
 * "SELECT 1; <anything>" would pass it — reject any semicolon outright rather than
 * trying to parse whether it's "just" a trailing one. A single SELECT statement
 * never needs one here.
 */
export async function datastoreSearchSql(sql: string): Promise<{ records: DatastoreRecord[] }> {
  if (!SELECT_ONLY.test(sql)) {
    throw new SqlValidationError("Only SELECT statements are permitted.");
  }
  if (sql.includes(";")) {
    throw new SqlValidationError("Only a single SELECT statement is permitted — remove the ';'.");
  }
  return callAction<{ records: DatastoreRecord[] }>("datastore_search_sql", { sql });
}
