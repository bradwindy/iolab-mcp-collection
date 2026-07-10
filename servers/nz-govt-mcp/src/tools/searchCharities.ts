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
import { searchCharities as searchCharitiesClient, type CharityRecord } from "../clients/charities.js";

export const searchCharitiesInputShape = {
  query: z.string().min(1).max(160).optional().describe("Free-text match against the charity's registered name."),
  registration_number: z
    .string()
    .regex(/^CC\d+$/i)
    .optional()
    .describe("Exact charity registration number, e.g. 'CC48103'."),
  status: z
    .enum(["Registered", "Deregistered", "Removed"])
    .optional()
    .describe("Filter by registration status. Omit to include all statuses."),
  limit: limitParam(50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchCharitiesOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchCharitiesInputShape);

function toConcise(record: CharityRecord) {
  return {
    registration_number: record.CharityRegistrationNumber,
    name: record.Name,
    status: record.RegistrationStatus,
    date_registered: record.DateRegistered,
    city: record.PostalAddressCity,
  };
}

function toDetailed(record: CharityRecord) {
  return {
    ...toConcise(record),
    suburb: record.PostalAddressSuburb,
    website: record.WebSiteURL,
    email: record.CharityEmailAddress,
    organisational_type: record.OrganisationalType,
    deregistration_date: record.DeregistrationDate,
  };
}

export async function searchCharitiesHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  if (!input.query && !input.registration_number) {
    return toolError(
      "Provide at least a `query` (name match) or `registration_number`.",
      "Searching with neither would return an unfiltered slice of the ~29,000-entry register.",
    );
  }

  try {
    const { records, totalCount } = await searchCharitiesClient({
      ...(input.query ? { query: input.query } : {}),
      ...(input.registration_number ? { registrationNumber: input.registration_number } : {}),
      ...(input.status ? { status: input.status } : {}),
      top: input.limit,
      skip: input.offset,
    });

    const page = describePage({ returned: records.length, total_count: totalCount, offset: input.offset });
    const items = records.map((record) => selectFormat(input.response_format, toConcise(record), toDetailed(record)));

    return jsonResult({
      items,
      ...page,
      notice: truncationNotice(
        input.offset + records.length,
        totalCount,
        "Narrow with `query`, `registration_number`, or `status`.",
      ),
      attribution: attribution("Charities Services Register", {
        url: "https://www.charities.govt.nz/charities-in-new-zealand/the-charities-register/",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
