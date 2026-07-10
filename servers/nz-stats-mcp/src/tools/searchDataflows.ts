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
  selectFormat,
  truncationNotice,
  UpstreamHttpError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { listDataflows, type SdmxDataflowSummary } from "../clients/statsNzSdmx.js";
import { resolveSubscriptionKey } from "../credentialHelper.js";
import { handleSdmxUpstreamError } from "../sdmxError.js";
import { SOURCE_NAME, SOURCE_URL } from "../constants.js";

export const searchDataflowsInputShape = {
  query: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "Free-text search across dataflow (table) names, e.g. 'population', 'enterprises', 'census', 'income'.",
    ),
  limit: limitParam(100, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchDataflowsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchDataflowsInputShape);

function toConcise(df: SdmxDataflowSummary) {
  return { dataflow_id: df.id, name: df.name };
}

function toDetailed(df: SdmxDataflowSummary) {
  return { dataflow_id: df.id, agency_id: df.agencyId, version: df.version, name: df.name };
}

/**
 * Search Aotearoa Data Explorer's full STATSNZ dataflow catalogue (911 tables as of
 * 2026-07-09) by keyword. This is the discovery step for nz_stats_query_dataflow: find a
 * dataflow_id here, then query it. The catalogue itself changes rarely, so it's cached
 * for 24h once fetched.
 */
export async function searchDataflowsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const credential = await resolveSubscriptionKey(env);
  if (!credential.ok) return credential.error;

  try {
    const allDataflows = await cached(env.MCP_CACHE, "nz-stats:dataflow-catalogue:STATSNZ", CACHE_TTL.METADATA, () =>
      listDataflows(credential.subscriptionKey),
    );

    const query = input.query.toLowerCase();
    const matches = allDataflows.filter(
      (df) => df.name.toLowerCase().includes(query) || df.id.toLowerCase().includes(query),
    );

    const page = paginate(matches, { limit: input.limit, offset: input.offset }, { defaultLimit: 20, maxLimit: 100 });
    const items = page.items.map((df) => selectFormat(input.response_format, toConcise(df), toDetailed(df)));

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow `query` or page with `offset`.",
      ),
      attribution: attribution(SOURCE_NAME, { url: SOURCE_URL }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return handleSdmxUpstreamError(error, env);
    throw error;
  }
}
