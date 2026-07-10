import { z } from "zod";
import {
  attribution,
  jsonResult,
  limitParam,
  offsetParam,
  paginate,
  responseFormatParam,
  toolError,
  truncationNotice,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { ArcgisQueryError } from "../clients/arcgisFeatureServer.js";
import { getAllLicenceHolderRows, SOURCE, type LicenceHolderRow } from "../clients/driverLicenceHolders.js";

const MAX_LIMIT = 200;

export const getLicenceHolderStatsInputShape = {
  region: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("Free-text, case-insensitive match against the region name, e.g. 'Auckland' or 'Otago'."),
  licence_class: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Free-text, case-insensitive match against the licence class, e.g. 'Motor Cars', 'Motorcycle'."),
  age_group: z.string().min(1).max(40).optional().describe("Exact age-group bucket, e.g. '24 or less', '25-29'."),
  financial_year: z.string().min(1).max(20).optional().describe("Exact NZTA financial year, e.g. '24/25'."),
  limit: limitParam(MAX_LIMIT, 50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const getLicenceHolderStatsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getLicenceHolderStatsInputShape);

function toRow(row: LicenceHolderRow) {
  return {
    region: row.region,
    licence_class: row.licenceClass,
    licence_stage: row.licenceStage,
    age_group: row.ageGroup,
    financial_year: row.financialYear,
    licence_count: row.licenceCount,
  };
}

export async function getLicenceHolderStatsHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const allRows = await getAllLicenceHolderRows(env.MCP_CACHE);

    const regionNeedle = input.region?.toLowerCase();
    const classNeedle = input.licence_class?.toLowerCase();
    const filtered = allRows.filter((row) => {
      if (regionNeedle && !row.region.toLowerCase().includes(regionNeedle)) return false;
      if (classNeedle && !row.licenceClass.toLowerCase().includes(classNeedle)) return false;
      if (input.age_group && row.ageGroup !== input.age_group) return false;
      if (input.financial_year && row.financialYear !== input.financial_year) return false;
      return true;
    });

    const page = paginate(filtered, { limit: input.limit, offset: input.offset }, { maxLimit: MAX_LIMIT });
    // response_format has no extra fields to add for this dataset — every field is already a compact
    // aggregate value — so both formats return the same shape; the parameter is still accepted for
    // cross-server consistency.
    const items = page.items.map(toRow);

    return jsonResult({
      items,
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      notice: truncationNotice(
        input.offset + page.items.length,
        page.total_count,
        "Narrow with `region`, `licence_class`, `age_group`, or `financial_year`.",
      ),
      attribution: attribution(SOURCE, {
        url: "https://opendata-nzta.opendata.arcgis.com/datasets/NZTA::driver-licence-holders-dataset-api",
      }),
    });
  } catch (error) {
    if (error instanceof ArcgisQueryError) {
      return toolError(error.message, "This may indicate an unexpected upstream schema change; please report it.");
    }
    throw error;
  }
}
