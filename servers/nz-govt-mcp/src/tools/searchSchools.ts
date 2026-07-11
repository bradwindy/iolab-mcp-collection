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
import { datastoreSearch, UpstreamActionError, UpstreamFetchError, type DatastoreRecord } from "../clients/datagovt.js";
import { SCHOOLS_DIRECTORY_RESOURCE_ID } from "../constants.js";

/**
 * Confirmed live via `SELECT DISTINCT "Authority" FROM <schools resource>` — the complete set,
 * byte-verified (each value round-tripped through Python `repr()` to rule out a stray space or
 * smart-quote mismatch, e.g. "State : Integrated" really does have spaces around the colon).
 */
const SCHOOL_AUTHORITIES = [
  "State",
  "State : Integrated",
  "Private : Fully Registered",
  "Private : Provisionally Registered",
  "Charter School",
] as const;

export const searchSchoolsInputShape = {
  query: z.string().min(1).max(160).optional().describe("Free-text match against school name."),
  region: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Free-text match against the regional council name, e.g. 'Auckland' or 'Wellington'."),
  authority: z
    .enum(SCHOOL_AUTHORITIES)
    .optional()
    .describe(
      "Exact match on the school's funding/governance authority, e.g. 'State : Integrated' for state-integrated schools.",
    ),
  city: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Exact match on the school's city, e.g. 'Christchurch' or 'Auckland' — case-sensitive. Use `query` or `region` for partial/fuzzy matches.",
    ),
  limit: limitParam(50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchSchoolsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchSchoolsInputShape);

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
    school_id: record.School_Id,
    suburb: record.Add1_Suburb,
    territorial_authority: record.Territorial_Authority,
    education_region: record.Education_Region,
    urban_rural: record.Urban_Rural_Indicator,
    coed_status: record.CoEd_Status,
    phone: record.Telephone,
    email: record.Email,
    website: record.URL,
  };
}

export async function searchSchoolsHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  if (!input.query && !input.region && !input.authority && !input.city) {
    return toolError(
      "Provide at least a `query` (school name), `region`, `authority`, or `city`.",
      "Searching with none of these would return an unfiltered slice of NZ's ~2,500 schools.",
    );
  }

  try {
    const combinedQuery = [input.query, input.region].filter(Boolean).join(" ");
    const filters: Record<string, string> = {};
    if (input.authority) filters.Authority = input.authority;
    if (input.city) filters.Add1_City = input.city;

    const { records, total } = await datastoreSearch({
      resourceId: SCHOOLS_DIRECTORY_RESOURCE_ID,
      ...(combinedQuery ? { query: combinedQuery } : {}),
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
      limit: input.limit,
      offset: input.offset,
    });

    const page = describePage({ returned: records.length, total_count: total, offset: input.offset });
    const items = records.map((record) => selectFormat(input.response_format, toConcise(record), toDetailed(record)));

    const cityIsSoleFilter = Boolean(input.city) && !input.query && !input.region && !input.authority;
    const notice =
      total === 0 && cityIsSoleFilter
        ? "No results — `city` is an exact, case-sensitive match (e.g. 'Christchurch', not 'christchurch'). Try `query` or `region` for partial matches."
        : truncationNotice(input.offset + records.length, total, "Narrow with `query`, `region`, `authority`, or `city`.");

    return jsonResult({
      items,
      ...page,
      notice,
      attribution: attribution("Education Counts School Directory (Ministry of Education)", {
        url: "https://www.educationcounts.govt.nz/directories/school-directory-api",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    if (error instanceof UpstreamActionError) {
      return toolError(error.message, "This is data.govt.nz's own error, not a network failure; verify the filters and retry.");
    }
    if (error instanceof UpstreamFetchError) {
      return toolError(error.message, "This looks like a transient network issue reaching data.govt.nz; retry in a moment.");
    }
    throw error;
  }
}
