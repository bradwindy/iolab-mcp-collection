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
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { ArcgisQueryError } from "../clients/arcgisFeatureServer.js";
import { queryTrafficCounts, SOURCE, type TmsTrafficCountRow } from "../clients/tmsTrafficCounts.js";

const MAX_LIMIT = 200;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const getTrafficCountsInputShape = {
  site_id: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe("Exact NZTA count-site reference (SiteRef), e.g. '00200444'. Omit and use `region` to discover sites."),
  region: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("Free-text, case-insensitive match against the region name, e.g. 'Gisborne' or 'Auckland'."),
  start_date: z
    .string()
    .regex(ISO_DATE, "Expected YYYY-MM-DD")
    .optional()
    .describe("ISO date (YYYY-MM-DD), inclusive lower bound on the count date."),
  end_date: z
    .string()
    .regex(ISO_DATE, "Expected YYYY-MM-DD")
    .optional()
    .describe("ISO date (YYYY-MM-DD), inclusive upper bound on the count date."),
  limit: limitParam(MAX_LIMIT, 50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const getTrafficCountsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getTrafficCountsInputShape);

function toConcise(row: TmsTrafficCountRow) {
  return {
    site_ref: row.SiteRef,
    region: row.regionName,
    description: row.siteDescription,
    date: new Date(row.startDate).toISOString().slice(0, 10),
    vehicle_class: row.classWeight,
    lane: row.laneNumber,
    count: row.trafficCount,
  };
}

function toDetailed(row: TmsTrafficCountRow) {
  return {
    ...toConcise(row),
    site_id: row.siteID,
    // NZTA does not publish what each flowDirection code means beyond "a lane-direction indicator".
    flow_direction_code: row.flowDirection,
  };
}

export async function getTrafficCountsHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const { rows, totalCount } = await queryTrafficCounts({
      ...(input.site_id ? { siteRef: input.site_id } : {}),
      ...(input.region ? { region: input.region } : {}),
      ...(input.start_date ? { startDateIso: input.start_date } : {}),
      ...(input.end_date ? { endDateIso: input.end_date } : {}),
      limit: input.limit,
      offset: input.offset,
    });

    const page = describePage({ returned: rows.length, total_count: totalCount, offset: input.offset });
    const items = rows.map((row) => selectFormat(input.response_format, toConcise(row), toDetailed(row)));

    return jsonResult({
      items,
      ...page,
      notice: truncationNotice(
        input.offset + rows.length,
        totalCount,
        "Narrow with `site_id`, `region`, `start_date`, or `end_date`.",
      ),
      attribution: attribution(SOURCE, {
        url: "https://opendata-nzta.opendata.arcgis.com/datasets/NZTA::tms-daily-traffic-counts-api",
      }),
    });
  } catch (error) {
    if (error instanceof ArcgisQueryError) {
      return toolError(error.message, "This may indicate an unexpected upstream schema change; please report it.");
    }
    throw error;
  }
}
