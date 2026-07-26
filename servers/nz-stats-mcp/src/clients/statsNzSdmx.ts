import { fetchWithBackoff, UpstreamHttpError } from "@iolab/mcp-kit";
import { AGENCY_ID, SDMX_BASE_URL, SOURCE_NAME, SUBSCRIPTION_KEY_HEADER } from "../constants.js";

const USER_AGENT = "nz-mcp-collection/nz-stats-mcp (+https://github.com/bradwindy/nz-mcp-collection)";

/** Generous headroom over queryDataflow's MAX_RAW_CHARS truncation so csv/xml formats can still
 * report a useful truncated preview; still far below the isolate's memory ceiling. */
const MAX_RAW_TEXT_BYTES = 500_000;
/** jsondata must parse as valid JSON, so there's no "truncate and preview" fallback — cap well
 * below the isolate's memory ceiling and fail cleanly if exceeded. */
const MAX_JSON_BODY_BYTES = 8_000_000;

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
  /** Omit (or pass "") for the newest version. Confirmed live 2026-07-10: this gateway 400s on
   * the literal string "latest" — the SDMX REST convention it actually honours is dropping the
   * version segment from the resource triple entirely (`{agency},{resource}` rather than
   * `{agency},{resource},{version}`). */
  version?: string;
  key: string;
  format?: string;
  extraQuery?: Record<string, string>;
}): Promise<SdmxDataResult> {
  const format = params.format ?? "jsondata";
  const encodedKey = params.key
    .split(".")
    .map((segment) => segment.split("+").map(encodeURIComponent).join("+"))
    .join(".");
  const resourceId = params.version
    ? `${params.agencyId},${params.dataflowId},${params.version}`
    : `${params.agencyId},${params.dataflowId}`;
  const url = new URL(`${SDMX_BASE_URL}/data/${resourceId}/${encodedKey}`);
  url.searchParams.set("format", format);
  for (const [name, value] of Object.entries(params.extraQuery ?? {})) {
    url.searchParams.set(name, value);
  }

  const response = await fetchWithBackoff(url, { headers: buildHeaders(params.subscriptionKey) });
  if (!response.ok) throw new UpstreamHttpError(SOURCE_NAME, response);

  const contentType = response.headers.get("content-type") ?? "";
  if (format === "jsondata") {
    // An unconstrained ("all") key against a large dataflow can produce a body of tens of MB —
    // well past what a Workers isolate can buffer via response.json(). Read (capped) then parse,
    // so an oversized response fails as a clean error rather than an isolate OOM.
    const { text, truncated } = await readBodyCapped(response, MAX_JSON_BODY_BYTES);
    if (truncated) {
      throw new Error(
        `SDMX-JSON response exceeded ${MAX_JSON_BODY_BYTES.toLocaleString()} bytes before EOF — the ` +
          `query is too unconstrained for this dataflow. Narrow the dimension key (avoid 'all' on ` +
          `large dataflows), or use start_period/end_period, or try format='csv' to inspect a smaller ` +
          `payload first.`,
      );
    }
    return { contentType, body: JSON.parse(text) as unknown, isJson: true };
  }
  const { text } = await readBodyCapped(response, MAX_RAW_TEXT_BYTES);
  return { contentType, body: text, isJson: false };
}

/** Read a response body up to `maxBytes`, cancelling the stream early rather than fully
 * buffering an arbitrarily large upstream payload (SDMX responses for unconstrained queries
 * can run tens of MB, well past what a Workers isolate can hold). */
async function readBodyCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: await response.text(), truncated: false };

  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytesRead >= maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  return { text, truncated };
}

// ---------------------------------------------------------------------------------
// SDMX-JSON (SDMX 2.0.0, per data-message/tools/schemas/2.0.0) flattening.
// ---------------------------------------------------------------------------------
// Confirmed live 2026-07-10 against real Aotearoa Data Explorer responses: the envelope is
// `{ meta, data: { dataSets: [...], structures: [...] }, errors }` — NOT the bare top-level
// `dataSets`/`structure` used by SDMX 2.1-compliant agencies (ECB, OECD). Dimensions are split
// across `data.structures[0].dimensions.series[]` / `.observation[]` per the official field guide
// (github.com/sdmx-twg/sdmx-json data-message/docs/1-sdmx-json-field-guide.md). When a dataflow has
// no series-level dimensions (as with every STATSNZ dataflow checked so far), all dimensions land
// in `observation[]` and data sits in a flat `dataSet.observations` map rather than nested under
// `dataSet.series[...].observations`; this flattener handles both shapes.

export type SdmxDimensionValue = { id: string; code: string; label: string };
export type SdmxObservation = { dims: SdmxDimensionValue[]; value: number | string | null };

type SdmxDimensionDef = { id: string; name?: string; values?: Array<{ id: string; name?: string }> };

type SdmxJsonBody = {
  data?: {
    dataSets?: Array<{
      series?: Record<string, { observations?: Record<string, unknown[]> }>;
      observations?: Record<string, unknown[]>;
    }>;
    structures?: Array<{
      dimensions?: {
        series?: SdmxDimensionDef[];
        observation?: SdmxDimensionDef[];
      };
    }>;
  };
};

function resolveDim(dim: SdmxDimensionDef, index: number | undefined): SdmxDimensionValue | null {
  if (index === undefined || Number.isNaN(index)) return null;
  const value = dim.values?.[index];
  if (!value) return null;
  return { id: dim.id, code: value.id, label: value.name ?? value.id };
}

function extractObsValue(obsArray: unknown): number | string | null {
  const rawValue = Array.isArray(obsArray) ? obsArray[0] : null;
  return typeof rawValue === "number" || typeof rawValue === "string" || rawValue === null ? rawValue : null;
}

/**
 * Flatten an SDMX-JSON data message into one row per observation, each carrying every
 * dimension's resolved {id, code, label}. Dimension ids retain their Stats NZ-specific
 * suffix (e.g. "AREA_POPES_SUB_004") — use `findDim(dims, "AREA_")` to look one up without
 * depending on which dataflow produced it.
 */
export function flattenSdmxJson(body: unknown): SdmxObservation[] {
  const root = body as SdmxJsonBody;
  const dataset = root.data?.dataSets?.[0];
  const dimensions = root.data?.structures?.[0]?.dimensions;
  if (!dataset || !dimensions) {
    throw new Error(
      "Unexpected SDMX-JSON response shape: missing data.dataSets[0] or data.structures[0].dimensions. " +
        "The upstream response format may differ from what this server expects — " +
        "try nz_stats_query_dataflow with format='xml' to inspect the raw structure.",
    );
  }

  const seriesDims = dimensions.series ?? [];
  const obsDims = dimensions.observation ?? [];
  const rows: SdmxObservation[] = [];

  if (dataset.series) {
    for (const [seriesKey, seriesEntry] of Object.entries(dataset.series)) {
      const seriesIndexes = seriesKey.split(":").map((s) => Number(s));
      const seriesResolved = seriesDims
        .map((dim, i) => resolveDim(dim, seriesIndexes[i]))
        .filter((d): d is SdmxDimensionValue => d !== null);

      for (const [obsKey, obsArray] of Object.entries(seriesEntry.observations ?? {})) {
        const obsIndexes = obsKey.split(":").map((s) => Number(s));
        const obsResolved = obsDims
          .map((dim, i) => resolveDim(dim, obsIndexes[i]))
          .filter((d): d is SdmxDimensionValue => d !== null);

        rows.push({ dims: [...seriesResolved, ...obsResolved], value: extractObsValue(obsArray) });
      }
    }
    return rows;
  }

  for (const [obsKey, obsArray] of Object.entries(dataset.observations ?? {})) {
    const obsIndexes = obsKey.split(":").map((s) => Number(s));
    const obsResolved = obsDims
      .map((dim, i) => resolveDim(dim, obsIndexes[i]))
      .filter((d): d is SdmxDimensionValue => d !== null);

    rows.push({ dims: obsResolved, value: extractObsValue(obsArray) });
  }

  return rows;
}

/** Find a dimension by id prefix (dimension ids are suffixed per-dataflow, e.g. "AREA_POPES_SUB_004"). */
export function findDim(dims: SdmxDimensionValue[], prefix: string): SdmxDimensionValue | undefined {
  return dims.find((d) => d.id.startsWith(prefix));
}
