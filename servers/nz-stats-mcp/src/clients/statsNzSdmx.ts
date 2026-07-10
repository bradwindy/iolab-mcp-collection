import { fetchWithBackoff, UpstreamHttpError } from "@nz-mcp/mcp-kit";
import { AGENCY_ID, SDMX_BASE_URL, SOURCE_NAME, SUBSCRIPTION_KEY_HEADER } from "../constants.js";

const USER_AGENT = "nz-mcp-collection/nz-stats-mcp (+https://mcp.iolab.nz)";

function buildHeaders(subscriptionKey: string): Record<string, string> {
  return {
    [SUBSCRIPTION_KEY_HEADER]: subscriptionKey,
    "Accept-Encoding": "gzip",
    "User-Agent": USER_AGENT,
  };
}

export type SdmxDataflowSummary = {
  id: string;
  agencyId: string;
  version: string;
  name: string;
};

// Matches blocks like:
//   <structure:Dataflow id="AGR_AGR_001" agencyID="STATSNZ" version="1.0" ...>
//     ...<common:Name xml:lang="en">Forestry by Regional Council</common:Name>...
//   </structure:Dataflow>
// A minimal regex scrape rather than a full XML parser: Workers has no DOMParser, the
// catalogue's XML shape is simple and stable, and pulling in an XML parsing dependency
// for one lightweight read isn't worth it. Verified against a live ~2.1MB/911-dataflow
// STATSNZ catalogue response on 2026-07-09.
const DATAFLOW_BLOCK_RE =
  /<structure:Dataflow id="([^"]+)" agencyID="([^"]+)" version="([^"]+)"[^>]*>([\s\S]*?)<\/structure:Dataflow>/g;
const NAME_RE = /<common:Name xml:lang="en">([\s\S]*?)<\/common:Name>/;

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&"); // must run last, or "&amp;lt;" etc. would double-decode
}

/**
 * List every dataflow (table) STATSNZ publishes in Aotearoa Data Explorer. This is a
 * structural metadata request, not a data request, but per the ADE API user guide it
 * still requires the subscription key header in production
 * (https://www.stats.govt.nz/tools/aotearoa-data-explorer/ade-api-user-guide/#subscribe).
 */
export async function listDataflows(subscriptionKey: string): Promise<SdmxDataflowSummary[]> {
  const url = new URL(`${SDMX_BASE_URL}/dataflow/${AGENCY_ID}/all`);
  url.searchParams.set("detail", "allstubs");

  const response = await fetchWithBackoff(url, { headers: buildHeaders(subscriptionKey) });
  if (!response.ok) throw new UpstreamHttpError(SOURCE_NAME, response);

  const xml = await response.text();
  const results: SdmxDataflowSummary[] = [];
  for (const match of xml.matchAll(DATAFLOW_BLOCK_RE)) {
    const id = match[1] ?? "";
    const agencyId = match[2] ?? AGENCY_ID;
    const version = match[3] ?? "1.0";
    const block = match[4] ?? "";
    const nameMatch = NAME_RE.exec(block);
    results.push({
      id,
      agencyId,
      version,
      name: nameMatch?.[1] ? decodeXmlEntities(nameMatch[1]) : id,
    });
  }
  return results;
}

export type SdmxDataResult = {
  contentType: string;
  /** Parsed JSON body when format is "jsondata"; raw text for any other format (csv/xml/...). */
  body: unknown;
  isJson: boolean;
};

/**
 * Fetch a data query against one SDMX dataflow. `key` is the caller-built, dot-separated
 * dimension key (see the ADE API user guide's "Data requests" section) — this client does
 * not interpret it, callers are responsible for dimension ordering.
 */
export async function fetchSdmxData(params: {
  subscriptionKey: string;
  agencyId: string;
  dataflowId: string;
  version: string;
  key: string;
  format?: string;
  extraQuery?: Record<string, string>;
}): Promise<SdmxDataResult> {
  const format = params.format ?? "jsondata";
  const encodedKey = params.key
    .split(".")
    .map((segment) => segment.split("+").map(encodeURIComponent).join("+"))
    .join(".");
  const url = new URL(
    `${SDMX_BASE_URL}/data/${params.agencyId},${params.dataflowId},${params.version}/${encodedKey}`,
  );
  url.searchParams.set("format", format);
  for (const [name, value] of Object.entries(params.extraQuery ?? {})) {
    url.searchParams.set(name, value);
  }

  const response = await fetchWithBackoff(url, { headers: buildHeaders(params.subscriptionKey) });
  if (!response.ok) throw new UpstreamHttpError(SOURCE_NAME, response);

  const contentType = response.headers.get("content-type") ?? "";
  if (format === "jsondata") {
    return { contentType, body: await response.json(), isJson: true };
  }
  return { contentType, body: await response.text(), isJson: false };
}

// ---------------------------------------------------------------------------------
// SDMX-JSON (SDMX 2.1 "data message") flattening.
// ---------------------------------------------------------------------------------
// Built against the documented SDMX-JSON 2.1 shape used by SDMX 2.1-compliant national
// statistics agencies (ECB, OECD, INSEE, and others): a `dataSets[0].series` map keyed by
// colon-separated dimension-value indexes, cross-referenced against
// `structure.dimensions.series[]` / `structure.dimensions.observation[]`, each entry
// carrying its own `values[]` code/label list. This has NOT been validated against a real
// authenticated Aotearoa Data Explorer response (no subscription key was available while
// building this server) — see README.md "Research notes" for how to verify and adjust this
// if Stats NZ's concrete implementation differs.

export type SdmxDimensionValue = { id: string; code: string; label: string };
export type SdmxObservation = { dims: SdmxDimensionValue[]; value: number | string | null };

type SdmxDimensionDef = { id: string; name?: string; values?: Array<{ id: string; name?: string }> };

type SdmxJsonBody = {
  dataSets?: Array<{
    series?: Record<string, { observations?: Record<string, unknown[]> }>;
  }>;
  structure?: {
    dimensions?: {
      series?: SdmxDimensionDef[];
      observation?: SdmxDimensionDef[];
    };
  };
};

function resolveDim(dim: SdmxDimensionDef, index: number | undefined): SdmxDimensionValue | null {
  if (index === undefined || Number.isNaN(index)) return null;
  const value = dim.values?.[index];
  if (!value) return null;
  return { id: dim.id, code: value.id, label: value.name ?? value.id };
}

/**
 * Flatten an SDMX-JSON data message into one row per observation, each carrying every
 * dimension's resolved {id, code, label}. Dimension ids retain their Stats NZ-specific
 * suffix (e.g. "AREA_POPES_SUB_004") — use `findDim(dims, "AREA_")` to look one up without
 * depending on which dataflow produced it.
 */
export function flattenSdmxJson(body: unknown): SdmxObservation[] {
  const root = body as SdmxJsonBody;
  const dataset = root.dataSets?.[0];
  const dimensions = root.structure?.dimensions;
  if (!dataset || !dimensions) {
    throw new Error(
      "Unexpected SDMX-JSON response shape: missing dataSets[0] or structure.dimensions. " +
        "The upstream response format may differ from what this server expects — " +
        "try nz_stats_query_dataflow with format='xml' to inspect the raw structure.",
    );
  }

  const seriesDims = dimensions.series ?? [];
  const obsDims = dimensions.observation ?? [];
  const rows: SdmxObservation[] = [];

  for (const [seriesKey, seriesEntry] of Object.entries(dataset.series ?? {})) {
    const seriesIndexes = seriesKey.split(":").map((s) => Number(s));
    const seriesResolved = seriesDims
      .map((dim, i) => resolveDim(dim, seriesIndexes[i]))
      .filter((d): d is SdmxDimensionValue => d !== null);

    for (const [obsKey, obsArray] of Object.entries(seriesEntry.observations ?? {})) {
      const obsIndexes = obsKey.split(":").map((s) => Number(s));
      const obsResolved = obsDims
        .map((dim, i) => resolveDim(dim, obsIndexes[i]))
        .filter((d): d is SdmxDimensionValue => d !== null);

      const rawValue = Array.isArray(obsArray) ? obsArray[0] : null;
      const value =
        typeof rawValue === "number" || typeof rawValue === "string" || rawValue === null
          ? rawValue
          : null;

      rows.push({ dims: [...seriesResolved, ...obsResolved], value });
    }
  }

  return rows;
}

/** Find a dimension by id prefix (dimension ids are suffixed per-dataflow, e.g. "AREA_POPES_SUB_004"). */
export function findDim(dims: SdmxDimensionValue[], prefix: string): SdmxDimensionValue | undefined {
  return dims.find((d) => d.id.startsWith(prefix));
}
