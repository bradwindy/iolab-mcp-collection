import { z } from "zod";
import {
  attribution,
  describePage,
  jsonResult,
  limitParam,
  offsetParam,
  responseFormatParam,
  selectFormat,
  toolError,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { datastoreSearch, type DatastoreRecord } from "../clients/datagovt.js";
import { ECE_DIRECTORY_RESOURCE_ID } from "../constants.js";

export const searchEarlyChildhoodServicesInputShape = {
  query: z.string().min(1).max(160).optional().describe("Free-text match against the service name."),
  region: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Free-text match against the regional council name, e.g. 'Auckland' or 'Wellington'."),
  limit: limitParam(50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchEarlyChildhoodServicesOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchEarlyChildhoodServicesInputShape);

function toConcise(record: DatastoreRecord) {
  return {
    name: record.Org_Name,
    type: record.Org_Type,
    authority: record.Authority,
    city: record.Add1_City,
    region: record.Regional_Council,
  };
}

function toDetailed(record: DatastoreRecord) {
  return {
    ...toConcise(record),
    ece_id: record.ECE_Id,
    suburb: record.Add1_Suburb,
    territorial_authority: record.Territorial_Authority,
    education_region: record.Education_Region,
    urban_rural: record.Urban_Rural_Indicator,
    hours_20_ece: record["20_Hrs_ECE"],
    phone: record.Telephone,
    email: record.Email,
  };
}

export async function searchEarlyChildhoodServicesHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  if (!input.query && !input.region) {
    return toolError(
      "Provide at least a `query` (service name) or `region`.",
      "Searching with neither would return an unfiltered slice of NZ's thousands of ECE services.",
    );
  }

  try {
    const combinedQuery = [input.query, input.region].filter(Boolean).join(" ");
    const { records, total } = await datastoreSearch({
      resourceId: ECE_DIRECTORY_RESOURCE_ID,
      ...(combinedQuery ? { query: combinedQuery } : {}),
      limit: input.limit,
      offset: input.offset,
    });

    const page = describePage({ returned: records.length, total_count: total, offset: input.offset });
    const items = records.map((record) => selectFormat(input.response_format, toConcise(record), toDetailed(record)));

    return jsonResult({
      items,
      ...page,
      notice: truncationNotice(input.offset + records.length, total, "Narrow with `query` or `region`."),
      attribution: attribution("Education Counts Early Childhood Services Directory (Ministry of Education)", {
        url: "https://www.educationcounts.govt.nz/directories/early-childhood-services-directory-api",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
