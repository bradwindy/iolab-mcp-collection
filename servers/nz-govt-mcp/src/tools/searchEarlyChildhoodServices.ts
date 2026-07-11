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
import { datastoreSearch, UpstreamActionError, type DatastoreRecord } from "../clients/datagovt.js";
import { ECE_DIRECTORY_RESOURCE_ID } from "../constants.js";

/**
 * Confirmed live via `SELECT DISTINCT "Authority" FROM <ECE resource>` — the complete non-empty
 * set, byte-verified (each value round-tripped through Python `repr()` to rule out a stray space
 * or smart-quote mismatch). A small number of records have an empty `Authority`; that's not a
 * meaningful filter value, so it's deliberately excluded here rather than offered as a third enum
 * option. `Add1_City` (the `city` filter below) is confirmed live too, via a direct
 * `filters={"Add1_City":"Christchurch"}` query against this resource (296 matches) — the schools
 * and ECE directories are separate datasets, so this was verified independently, not assumed from
 * the schools resource sharing the same column name.
 */
const ECE_AUTHORITIES = ["Community based", "Privately owned"] as const;

export const searchEarlyChildhoodServicesInputShape = {
  query: z.string().min(1).max(160).optional().describe("Free-text match against the service name."),
  region: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Free-text match against the regional council name, e.g. 'Auckland' or 'Wellington'."),
  authority: z
    .enum(ECE_AUTHORITIES)
    .optional()
    .describe("Exact match on the service's ownership type: 'Community based' or 'Privately owned'."),
  city: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe(
      "Exact match on the service's city, e.g. 'Christchurch' or 'Auckland' — case-sensitive. Use `query` or `region` for partial/fuzzy matches.",
    ),
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

  if (!input.query && !input.region && !input.authority && !input.city) {
    return toolError(
      "Provide at least a `query` (service name), `region`, `authority`, or `city`.",
      "Searching with none of these would return an unfiltered slice of NZ's thousands of ECE services.",
    );
  }

  try {
    const combinedQuery = [input.query, input.region].filter(Boolean).join(" ");
    const filters: Record<string, string> = {};
    if (input.authority) filters.Authority = input.authority;
    if (input.city) filters.Add1_City = input.city;

    const { records, total } = await datastoreSearch({
      resourceId: ECE_DIRECTORY_RESOURCE_ID,
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
      attribution: attribution("Education Counts Early Childhood Services Directory (Ministry of Education)", {
        url: "https://www.educationcounts.govt.nz/directories/early-childhood-services-directory-api",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    if (error instanceof UpstreamActionError) {
      return toolError(error.message, "This is data.govt.nz's own error, not a network failure; verify the filters and retry.");
    }
    throw error;
  }
}
