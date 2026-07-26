import { fetchWithBackoff } from "@iolab/mcp-kit";

// Shared query helper for NZTA's three open ArcGIS FeatureServer/0 layers (TMS daily traffic counts,
// motor vehicle register, driver licence holders) — all three expose the identical Esri REST query
// shape, confirmed live against each service:
//   GET {baseUrl}/query?where=<SQL predicate>&outFields=*&f=json&resultRecordCount=N&resultOffset=N
//   GET {baseUrl}/query?where=<SQL predicate>&returnCountOnly=true&f=json
// Esri REST always answers with HTTP 200, even on a malformed query — errors surface as a JSON body
// `{"error":{"code":400,"message":"..."}}` instead of a non-2xx status, so this helper checks for that
// explicitly rather than relying on `response.ok` (confirmed live: a bad field name returns
// `HTTP 200 {"error":{"code":400,"message":"Cannot perform query. Invalid query parameters."...}}`).

export class ArcgisQueryError extends Error {
  constructor(
    public readonly source: string,
    message: string,
  ) {
    super(`${source}: ${message}`);
    this.name = "ArcgisQueryError";
  }
}

/** Escape a single-quoted SQL string literal for an Esri REST `where` clause (double the quote). */
export function arcgisStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Case-insensitive partial match, e.g. `arcgisContains("regionName", "gisborne")`. */
export function arcgisContains(field: string, value: string): string {
  return `UPPER(${field}) LIKE UPPER('%${value.replace(/'/g, "''").replace(/%/g, "")}%')`;
}

type ArcgisFeature<A> = { attributes: A };
type ArcgisQueryResponse<A> = { features?: Array<ArcgisFeature<A>>; error?: { code: number; message: string } };
type ArcgisCountResponse = { count?: number; error?: { code: number; message: string } };

async function arcgisFetchJson<T extends { error?: { code: number; message: string } }>(
  source: string,
  url: URL,
): Promise<T> {
  const response = await fetchWithBackoff(url);
  if (!response.ok) {
    throw new ArcgisQueryError(source, `HTTP ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as T;
  if (body.error) {
    throw new ArcgisQueryError(source, body.error.message);
  }
  return body;
}

/** Total number of rows matching `where`, via `returnCountOnly=true` (cheap: no feature payload). */
export async function countArcgisFeatures(source: string, baseUrl: string, where: string): Promise<number> {
  const url = new URL(`${baseUrl}/query`);
  url.searchParams.set("where", where);
  url.searchParams.set("returnCountOnly", "true");
  url.searchParams.set("f", "json");
  const body = await arcgisFetchJson<ArcgisCountResponse>(source, url);
  return body.count ?? 0;
}

/** One page of attribute rows matching `where`, in a stable order for consistent pagination. */
export async function queryArcgisFeatures<A extends Record<string, unknown>>(
  source: string,
  baseUrl: string,
  params: {
    where: string;
    outFields?: string;
    orderByFields: string;
    resultOffset: number;
    resultRecordCount: number;
  },
): Promise<A[]> {
  const url = new URL(`${baseUrl}/query`);
  url.searchParams.set("where", params.where);
  url.searchParams.set("outFields", params.outFields ?? "*");
  url.searchParams.set("orderByFields", params.orderByFields);
  url.searchParams.set("resultOffset", String(params.resultOffset));
  url.searchParams.set("resultRecordCount", String(params.resultRecordCount));
  url.searchParams.set("f", "json");
  const body = await arcgisFetchJson<ArcgisQueryResponse<A>>(source, url);
  return (body.features ?? []).map((feature) => feature.attributes);
}
