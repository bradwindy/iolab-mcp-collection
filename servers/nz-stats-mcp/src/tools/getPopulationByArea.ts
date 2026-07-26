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
  POPULATION_AGE_TOTAL_CODE,
  POPULATION_AVAILABLE_YEARS,
  POPULATION_DATAFLOW_ID,
  POPULATION_DATAFLOW_NAME,
  POPULATION_DATAFLOW_VERSION,
  POPULATION_DEFAULT_AREA_CODES,
  POPULATION_SEX_TOTAL_CODE,
  REGIONAL_COUNCIL_NAMES,
  SOURCE_NAME,
  SOURCE_URL,
} from "../constants.js";
import { filterKnownYears } from "../yearRange.js";

export const getPopulationByAreaInputShape = {
  area_code: z
    .string()
    .optional()
    .describe(
      "One or more area codes, comma-separated, to filter by. Regional Council codes: " +
        "01 Northland, 02 Auckland, 03 Waikato, 04 Bay of Plenty, 05 Gisborne, 06 Hawke's Bay, " +
        "07 Taranaki, 08 Manawatu-Whanganui, 09 Wellington, 12 West Coast, 13 Canterbury, " +
        "14 Otago, 15 Southland, 16 Tasman, 17 Nelson, 18 Marlborough, 99 Area outside region, " +
        "RC9999 New Zealand total, NIRC/SIRC North/South Island totals. SA2 (small area) numeric " +
        "codes also work but are not individually documented here — find them via " +
        "nz_stats_search_dataflows or the Aotearoa Data Explorer browser. Omit for the default " +
        "view: all 16 regions plus national and island totals.",
    ),
  start_year: z
    .number()
    .int()
    .optional()
    .describe(`Earliest 30 June reference year to include. Available years: ${POPULATION_AVAILABLE_YEARS.join(", ")}.`),
  end_year: z
    .number()
    .int()
    .optional()
    .describe(`Latest 30 June reference year to include. Available years: ${POPULATION_AVAILABLE_YEARS.join(", ")}.`),
  limit: limitParam(500, 100),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const getPopulationByAreaOutputShape = {
  observations: z.array(z.record(z.string(), z.unknown())),
  dataflow: z.object({ id: z.string(), name: z.string(), version: z.string() }),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getPopulationByAreaInputShape);

function toRow(obs: SdmxObservation, detailed: boolean) {
  const area = findDim(obs.dims, "AREA_");
  const sex = findDim(obs.dims, "SEX_");
  const age = findDim(obs.dims, "AGE_");
  const year = findDim(obs.dims, "YEAR_");

  const areaCode = area?.code ?? null;
  const concise = {
    area_code: areaCode,
    area_name: (areaCode && REGIONAL_COUNCIL_NAMES[areaCode]) ?? area?.label ?? null,
    year: year?.code ? Number(year.code) : null,
    population: obs.value,
  };
  if (!detailed) return concise;

  return {
    ...concise,
    sex_code: sex?.code ?? null,
    sex_label: sex?.label ?? null,
    age_code: age?.code ?? null,
    age_label: age?.label ?? null,
  };
}

/**
 * Curated tool over STATSNZ's POPES_SUB_004 dataflow ("Subnational population estimates
 * (RC, SA2), by age and sex, at 30 June 1996-2025"). Returns population totals (all ages,
 * both sexes) by area and year. See constants.ts for the dataflow's confirmed dimension
 * layout, and README.md "Research notes" for what could and couldn't be verified without a
 * live subscription key.
 */
export async function getPopulationByAreaHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const credential = await resolveSubscriptionKey(env);
  if (!credential.ok) return credential.error;

  const areaCodes = input.area_code
    ? input.area_code
        .split(",")
        .map((code) => code.trim())
        .filter((code) => code.length > 0)
    : POPULATION_DEFAULT_AREA_CODES;

  let yearCodes = POPULATION_AVAILABLE_YEARS;
  if (input.start_year !== undefined || input.end_year !== undefined) {
    yearCodes = filterKnownYears(POPULATION_AVAILABLE_YEARS, input.start_year, input.end_year);
    if (yearCodes.length === 0) {
      return toolError(
        `No population estimates exist for the requested year range.`,
        `This dataflow only has data for: ${POPULATION_AVAILABLE_YEARS.join(", ")}.`,
      );
    }
  }

  // Dimension order is YEAR.SEX.AGE.AREA — confirmed live 2026-07-10 via a CSV probe
  // (`format=csv` header came back "YEAR_POPES_SUB_004,SEX_POPES_SUB_004,AGE_POPES_SUB_004,
  // AREA_POPES_SUB_004"). This does NOT match the row-then-column order the LAYOUT_ROW/
  // LAYOUT_COLUMN annotations in constants.ts implied (AREA.SEX.AGE.YEAR) — that assumption
  // was wrong; LAYOUT annotations do not reliably predict REST key segment order.
  const key = `${yearCodes.join("+")}.${POPULATION_SEX_TOTAL_CODE}.${POPULATION_AGE_TOTAL_CODE}.${areaCodes.join("+")}`;

  try {
    const result = await cached(env.MCP_CACHE, `nz-stats:popes_sub_004:${key}`, CACHE_TTL.METADATA, () =>
      fetchSdmxData({
        subscriptionKey: credential.subscriptionKey,
        agencyId: AGENCY_ID,
        dataflowId: POPULATION_DATAFLOW_ID,
        version: POPULATION_DATAFLOW_VERSION,
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
        id: POPULATION_DATAFLOW_ID,
        name: POPULATION_DATAFLOW_NAME,
        version: POPULATION_DATAFLOW_VERSION,
      },
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow `area_code`/`start_year`/`end_year` or page with `offset`.",
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
