import { z } from "zod";
import {
  attribution,
  cached,
  CACHE_TTL,
  jsonResult,
  limitParam,
  offsetParam,
  paginate,
  responseFormatParam,
  toolError,
  truncationNotice,
  UpstreamHttpError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { fetchSdmxData, flattenSdmxJson, type SdmxObservation } from "../clients/statsNzSdmx.js";
import { resolveSubscriptionKey } from "../credentialHelper.js";
import { handleSdmxUpstreamError } from "../sdmxError.js";
import { AGENCY_ID, SOURCE_NAME, SOURCE_URL } from "../constants.js";

const MAX_RAW_CHARS = 20_000;

export const queryDataflowInputShape = {
  dataflow_id: z
    .string()
    .min(1)
    .describe(
      "The SDMX dataflow (table) id, e.g. 'AGR_AGR_001'. Find ids with nz_stats_search_dataflows, " +
        "or via Aotearoa Data Explorer (explore.data.stats.govt.nz) > open a table > 'Developer API' " +
        "menu, which shows the exact data/structure query URLs for that table.",
    ),
  agency_id: z.string().optional().describe("SDMX agency id. Defaults to 'STATSNZ' (the only publisher on Aotearoa Data Explorer)."),
  version: z.string().optional().describe("Dataflow version, e.g. '1.0'. Defaults to 'latest'."),
  dimension_key: z
    .string()
    .optional()
    .describe(
      "Dot-separated dimension key selecting what to return, in the dimension order that table uses " +
        "(get it right by copying the 'Data query' URL from that table's Developer API menu in Aotearoa " +
        "Data Explorer, then just pass everything after the version in the path). Use '+' to OR multiple " +
        "codes within one dimension, leave a segment blank for 'all codes'. Defaults to 'all' (every code, " +
        "every dimension) — small tables only; large tables will need narrowing.",
    ),
  start_period: z
    .string()
    .optional()
    .describe(
      "SDMX startPeriod filter (e.g. '2020' or '2020-Q1'). Only takes effect if the table has a true " +
        "SDMX time dimension; many Aotearoa Data Explorer tables instead encode time as a plain coded " +
        "dimension (see dimension_key) and ignore this parameter.",
    ),
  end_period: z.string().optional().describe("SDMX endPeriod filter — see start_period."),
  format: z
    .enum(["jsondata", "xml", "csv", "csvfile", "csvfilewithlabels"])
    .default("jsondata")
    .describe(
      "Response format. 'jsondata' is parsed and paginated by this tool; all other formats are returned " +
        "as raw truncated text.",
    ),
  limit: limitParam(500, 100),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const queryDataflowOutputShape = {
  dataflow_id: z.string(),
  agency_id: z.string(),
  version: z.string(),
  key_used: z.string(),
  format: z.string(),
  observations: z.array(z.record(z.string(), z.unknown())),
  raw: z.string().nullable(),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(queryDataflowInputShape);

/** Strip a dataflow-specific dimension suffix (e.g. "AREA_POPES_SUB_004" -> "AREA") for readability. */
function simplifyDimId(fullId: string, dataflowId: string): string {
  const suffix = `_${dataflowId}`;
  return fullId.endsWith(suffix) ? fullId.slice(0, -suffix.length) : fullId;
}

function toRow(obs: SdmxObservation, dataflowId: string, detailed: boolean): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const dim of obs.dims) {
    const key = simplifyDimId(dim.id, dataflowId);
    row[key] = dim.code;
    if (detailed) row[`${key}_label`] = dim.label;
  }
  row.value = obs.value;
  return row;
}

/**
 * Escape hatch for any STATSNZ dataflow not covered by the curated tools. Advanced usage:
 * the caller is expected to already know (or discover via nz_stats_search_dataflows and the
 * ADE portal's Developer API menu) the dataflow id and, for anything beyond the default
 * "all", the dimension key format that table uses.
 */
export async function queryDataflowHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const credential = await resolveSubscriptionKey(env);
  if (!credential.ok) return credential.error;

  const agencyId = input.agency_id?.trim() || AGENCY_ID;
  // Requested version, if any — passed through as-is to fetchSdmxData, which omits the version
  // segment entirely when this is undefined (confirmed live: the literal string "latest" 400s).
  const requestedVersion = input.version?.trim() || undefined;
  const version = requestedVersion ?? "latest";
  const key = input.dimension_key?.trim() || "all";
  const extraQuery: Record<string, string> = {
    ...(input.start_period ? { startPeriod: input.start_period } : {}),
    ...(input.end_period ? { endPeriod: input.end_period } : {}),
  };

  try {
    const result = await cached(
      env.MCP_CACHE,
      `nz-stats:query:${agencyId}:${input.dataflow_id}:${version}:${key}:${input.format}:${JSON.stringify(extraQuery)}`,
      CACHE_TTL.METADATA,
      () =>
        fetchSdmxData({
          subscriptionKey: credential.subscriptionKey,
          agencyId,
          dataflowId: input.dataflow_id,
          ...(requestedVersion ? { version: requestedVersion } : {}),
          key,
          format: input.format,
          extraQuery,
        }),
    );

    if (!result.isJson) {
      const text = result.body as string;
      const truncated = text.length > MAX_RAW_CHARS;
      return jsonResult({
        dataflow_id: input.dataflow_id,
        agency_id: agencyId,
        version,
        key_used: key,
        format: input.format,
        observations: [],
        raw: truncated ? text.slice(0, MAX_RAW_CHARS) : text,
        total_count: 0,
        has_more: false,
        next_offset: null,
        notice: truncated
          ? `Showing the first ${MAX_RAW_CHARS} characters of ${text.length}. Narrow \`dimension_key\`, or use format='jsondata' for paginated structured output.`
          : "",
        attribution: attribution(SOURCE_NAME, { url: SOURCE_URL }),
      });
    }

    const detailed = input.response_format === "detailed";
    const observations = flattenSdmxJson(result.body);
    const rows = observations.map((obs) => toRow(obs, input.dataflow_id, detailed));
    const page = paginate(rows, { limit: input.limit, offset: input.offset }, { defaultLimit: 100, maxLimit: 500 });

    return jsonResult({
      dataflow_id: input.dataflow_id,
      agency_id: agencyId,
      version,
      key_used: key,
      format: input.format,
      observations: page.items,
      raw: null,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow `dimension_key` or page with `offset`.",
      ),
      attribution: attribution(SOURCE_NAME, { url: SOURCE_URL }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return handleSdmxUpstreamError(error, env);
    if (error instanceof Error && error.message.includes("Unexpected SDMX-JSON")) {
      return toolError(error.message);
    }
    throw error;
  }
}
