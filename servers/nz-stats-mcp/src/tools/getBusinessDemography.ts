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
import { fetchSdmxData, findDim, flattenSdmxJson, type SdmxObservation } from "../clients/statsNzSdmx.js";
import { resolveSubscriptionKey } from "../credentialHelper.js";
import { handleSdmxUpstreamError } from "../sdmxError.js";
import {
  AGENCY_ID,
  BUSINESS_DEMOGRAPHY_DATAFLOW_ID,
  BUSINESS_DEMOGRAPHY_DATAFLOW_NAME,
  BUSINESS_DEMOGRAPHY_DATAFLOW_VERSION,
  BUSINESS_DEMOGRAPHY_INDUSTRY_TOTAL_CODE,
  BUSINESS_DEMOGRAPHY_YEAR_MAX,
  BUSINESS_DEMOGRAPHY_YEAR_MIN,
  SOURCE_NAME,
  SOURCE_URL,
} from "../constants.js";
import { consecutiveYearRange } from "../yearRange.js";

export const getBusinessDemographyInputShape = {
  industry_code: z
    .string()
    .optional()
    .describe(
      "An ANZSIC06 industry code (Stats NZ's business classification), e.g. an A-S top-level " +
        "division code. Defaults to 'TOTAL' (all industries). Find specific codes via the " +
        "Aotearoa Data Explorer browser's codelist for this table, or nz_stats_query_dataflow.",
    ),
  start_year: z
    .number()
    .int()
    .optional()
    .describe(`Earliest year (as at February) to include, between ${BUSINESS_DEMOGRAPHY_YEAR_MIN} and ${BUSINESS_DEMOGRAPHY_YEAR_MAX}.`),
  end_year: z
    .number()
    .int()
    .optional()
    .describe(`Latest year (as at February) to include, between ${BUSINESS_DEMOGRAPHY_YEAR_MIN} and ${BUSINESS_DEMOGRAPHY_YEAR_MAX}.`),
  limit: limitParam(500, 100),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const getBusinessDemographyOutputShape = {
  observations: z.array(z.record(z.string(), z.unknown())),
  dataflow: z.object({ id: z.string(), name: z.string(), version: z.string() }),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getBusinessDemographyInputShape);

function toRow(obs: SdmxObservation, detailed: boolean) {
  const year = findDim(obs.dims, "YEAR_");
  const industry = findDim(obs.dims, "ANZSIC06_");
  const measure = findDim(obs.dims, "MEASURE_");

  const concise = {
    year: year?.code ? Number(year.code) : null,
    industry_code: industry?.code ?? null,
    industry_label: industry?.label ?? null,
    measure: measure?.label ?? measure?.code ?? null,
    value: obs.value,
  };
  if (!detailed) return concise;

  return { ...concise, measure_code: measure?.code ?? null };
}

/**
 * Curated tool over STATSNZ's BDS_BDS_004 dataflow ("Enterprises by industry 2000-2025"),
 * part of the Business Demography Statistics collection. Returns enterprise counts (and
 * whatever other measures the table publishes) by industry and year. See constants.ts for
 * confirmed dimension layout and README.md "Research notes" for open questions.
 */
export async function getBusinessDemographyHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const credential = await resolveSubscriptionKey(env);
  if (!credential.ok) return credential.error;

  if (
    (input.start_year !== undefined && (input.start_year < BUSINESS_DEMOGRAPHY_YEAR_MIN || input.start_year > BUSINESS_DEMOGRAPHY_YEAR_MAX)) ||
    (input.end_year !== undefined && (input.end_year < BUSINESS_DEMOGRAPHY_YEAR_MIN || input.end_year > BUSINESS_DEMOGRAPHY_YEAR_MAX))
  ) {
    return toolError(
      `Year out of range.`,
      `This dataflow covers ${BUSINESS_DEMOGRAPHY_YEAR_MIN}-${BUSINESS_DEMOGRAPHY_YEAR_MAX}.`,
    );
  }

  if (input.start_year !== undefined && input.end_year !== undefined && input.start_year > input.end_year) {
    return toolError(
      `start_year (${input.start_year}) is after end_year (${input.end_year}).`,
      `Swap them, or omit one to leave that side of the range open.`,
    );
  }

  const industryCode = input.industry_code?.trim() || BUSINESS_DEMOGRAPHY_INDUSTRY_TOTAL_CODE;
  const yearCodes = consecutiveYearRange(
    BUSINESS_DEMOGRAPHY_YEAR_MIN,
    BUSINESS_DEMOGRAPHY_YEAR_MAX,
    input.start_year,
    input.end_year,
  );
  if (yearCodes.length === 0) {
    return toolError(
      `No business demography data exists for the requested year range.`,
      `This dataflow covers ${BUSINESS_DEMOGRAPHY_YEAR_MIN}-${BUSINESS_DEMOGRAPHY_YEAR_MAX}.`,
    );
  }

  // Dimension order is ANZSIC06.YEAR.MEASURE — confirmed live 2026-07-10 via a CSV probe
  // (`format=csv` header came back "ANZSIC06_BDS_BDS_004,YEAR_BDS_BDS_004,MEASURE_BDS_BDS_004").
  // This does NOT match the row-then-column order the LAYOUT_ROW/LAYOUT_COLUMN annotations in
  // constants.ts implied — that assumption was wrong. MEASURE is left blank ("all measures").
  const key = `${industryCode}.${yearCodes.join("+")}.`;

  try {
    const result = await cached(env.MCP_CACHE, `nz-stats:bds_bds_004:${key}`, CACHE_TTL.METADATA, () =>
      fetchSdmxData({
        subscriptionKey: credential.subscriptionKey,
        agencyId: AGENCY_ID,
        dataflowId: BUSINESS_DEMOGRAPHY_DATAFLOW_ID,
        version: BUSINESS_DEMOGRAPHY_DATAFLOW_VERSION,
        key,
      }),
    );

    const observations = flattenSdmxJson(result.body);
    const detailed = input.response_format === "detailed";
    const rows = observations.map((obs) => toRow(obs, detailed));

    const page = paginate(rows, { limit: input.limit, offset: input.offset }, { defaultLimit: 100, maxLimit: 500 });

    return jsonResult({
      observations: page.items,
      dataflow: {
        id: BUSINESS_DEMOGRAPHY_DATAFLOW_ID,
        name: BUSINESS_DEMOGRAPHY_DATAFLOW_NAME,
        version: BUSINESS_DEMOGRAPHY_DATAFLOW_VERSION,
      },
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow `industry_code`/`start_year`/`end_year` or page with `offset`.",
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
