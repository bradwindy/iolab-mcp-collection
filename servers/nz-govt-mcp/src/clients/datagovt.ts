import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";

const BASE_URL = "https://catalogue.data.govt.nz/api/3/action";
const SOURCE = "data.govt.nz";
const USER_AGENT = "nz-mcp-collection/nz-govt-mcp (+https://github.com/bradwindy/nz-mcp-collection)";

/** Thrown by datastoreSearchSql's input guard — always a caller-actionable message. */
export class SqlValidationError extends Error {}

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

  const response = await fetchWithBackoff(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);

  const body = (await response.json()) as CkanResponse<T>;
  if (!body.success) {
    throw new Error(`${SOURCE} action '${action}' failed: ${body.error?.message ?? "unknown error"}`);
  }
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
