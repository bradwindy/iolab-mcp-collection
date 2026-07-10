import { z } from "zod";
import {
  attribution,
  describePage,
  jsonResult,
  limitParam,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { searchOpenData } from "../clients/aucklandOpenData.js";

export const searchAucklandOpenDataInputShape = {
  query: z.string().min(1).max(200).describe("Free-text search across Auckland Council open dataset titles and descriptions."),
  limit: limitParam(50),
  start_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("1-based-following pagination cursor: skip this many matches before returning results."),
};

export const searchAucklandOpenDataOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchAucklandOpenDataInputShape);

export async function searchAucklandOpenDataHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const { items, numberMatched } = await searchOpenData({
      query: input.query,
      limit: input.limit,
      startIndex: input.start_index,
    });

    const page = describePage({ returned: items.length, total_count: numberMatched, offset: input.start_index });

    return jsonResult({
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        type: item.type,
        snippet: item.snippet,
        tags: item.tags,
        service_url: item.url,
        license: item.license,
      })),
      ...page,
      notice: truncationNotice(input.start_index + items.length, numberMatched, "Narrow `query` to refine results."),
      attribution: attribution("Auckland Council Open Data", {
        url: "https://data-aucklandcouncil.opendata.arcgis.com/",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
