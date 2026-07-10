import { z } from "zod";
import {
  attribution,
  cached,
  CACHE_TTL,
  jsonResult,
  limitParam,
  missingCredentialError,
  offsetParam,
  paginate,
  responseFormatParam,
  selectFormat,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { getCredential } from "@nz-mcp/credentials";
import { EA_DISPATCH_API_KEY, SERVER_SLUG } from "../constants.js";
import { getRealTimeDispatch, type DispatchRecord } from "../clients/electricityAuthority.js";

export const getElectricityDispatchInputShape = {
  point_of_connection_code: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Filter to one grid injection/offtake point, e.g. 'HAY2201'. Omit to return the latest interval " +
        "for every point of connection nationwide (several hundred rows).",
    ),
  at_datetime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional()
    .describe(
      "Fetch a specific past 5-minute interval instead of the latest one, as NZ local time 'YYYY-MM-DDTHH:MM' " +
        "(e.g. '2026-07-01T14:30'). Omit for the most recent interval.",
    ),
  limit: limitParam(250, 50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const getElectricityDispatchOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getElectricityDispatchInputShape);

function toConcise(record: DispatchRecord) {
  return {
    point_of_connection_code: record.PointOfConnectionCode,
    interval_datetime_nz: record.FiveMinuteIntervalDatetime,
    price_dollars_per_mwh: record.DollarsPerMegawattHour,
    generation_mw: record.SPDGenerationMegawatt,
    load_mw: record.SPDLoadMegawatt,
  };
}

function toDetailed(record: DispatchRecord) {
  return {
    ...toConcise(record),
    interval_number: record.FiveMinuteIntervalNumber,
    run_datetime_utc: record.RunDateTime,
  };
}

/**
 * `env` supplies the D1-backed credential lookup (the Electricity Authority requires a
 * subscription key for its "Wholesale market prices" product) and the KV cache — dispatch data
 * refreshes on a 5-minute cycle, so a short NEAR_REALTIME cache absorbs bursts of repeat calls
 * without serving genuinely stale prices.
 */
export async function getElectricityDispatchHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const apiKey = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, EA_DISPATCH_API_KEY, env.ENCRYPTION_KEY);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, EA_DISPATCH_API_KEY, env.PORTAL_URL);

  const cacheKey = `nz-markets:ea:dispatch:${input.point_of_connection_code ?? "all"}:${input.at_datetime ?? "latest"}`;

  try {
    const records = await cached(env.MCP_CACHE, cacheKey, CACHE_TTL.NEAR_REALTIME, () =>
      getRealTimeDispatch({
        apiKey,
        ...(input.point_of_connection_code ? { pointOfConnectionCode: input.point_of_connection_code } : {}),
        ...(input.at_datetime ? { atDatetime: input.at_datetime } : {}),
      }),
    );

    const page = paginate(records, { limit: input.limit, offset: input.offset }, { defaultLimit: 50, maxLimit: 250 });
    const items = page.items.map((record) => selectFormat(input.response_format, toConcise(record), toDetailed(record)));

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow with `point_of_connection_code`, or page with `offset`.",
      ),
      attribution: attribution("Electricity Authority — Electricity Market Information (EMI), real-time dispatch", {
        url: "https://www.ea.govt.nz/data-and-insights/tools-and-apis/",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
