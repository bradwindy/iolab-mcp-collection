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
} from "@iolab/mcp-kit";
import { searchDigitalNz as searchDigitalNzClient, type DigitalNzRecord } from "../clients/digitalnz.js";

export const searchDigitalnzInputShape = {
  query: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Free-text search across titles, descriptions, subjects, and tags."),
  category: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe(
      "Restrict to one DigitalNZ category facet value, e.g. 'Images', 'Newspapers', 'Research papers', 'Articles', 'Audio', 'Archives', 'Books'.",
    ),
  geo_bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .optional()
    .describe("Geographic bounding box as 'north,west,south,east' decimal degrees, to scope results to a region."),
  sort: z
    .enum(["relevance", "date", "syndication_date"])
    .default("relevance")
    .describe("Sort order. 'date' and 'syndication_date' are the only fields DigitalNZ supports sorting by."),
  sort_direction: z.enum(["asc", "desc"]).default("desc").describe("Sort direction when `sort` is not 'relevance'."),
  include_facets: z
    .boolean()
    .default(false)
    .describe("Include category/collection/content-partner facet counts alongside the results."),
  limit: limitParam(100, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchDigitalnzOutputShape = {
  items: z.array(
    z.object({
      id: z.number(),
      title: z.string().nullable(),
      category: z.array(z.string()),
      collection: z.string().nullable(),
      content_partner: z.string().nullable(),
      date: z.string().nullable(),
      rights: z.string().nullable(),
      thumbnail_url: z.string().nullable(),
      landing_url: z.string().nullable(),
      description: z.string().nullable().optional(),
      creator: z.array(z.string()).optional(),
      subject: z.array(z.string()).optional(),
      tag: z.array(z.string()).optional(),
      usage: z.array(z.string()).optional(),
      copyright: z.array(z.string()).optional(),
      language: z.array(z.string()).optional(),
      is_commercial_use: z.boolean().nullable().optional(),
      source_url: z.string().nullable().optional(),
      large_thumbnail_url: z.string().nullable().optional(),
    }),
  ),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  facets: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional(), license: z.string().optional() }),
};

const inputSchema = z.object(searchDigitalnzInputShape);

function toConcise(record: DigitalNzRecord) {
  return {
    id: record.id,
    title: record.title ?? null,
    category: record.category ?? [],
    collection: record.display_collection ?? null,
    content_partner: record.display_content_partner ?? null,
    date: record.display_date ?? null,
    rights: record.rights ?? null,
    thumbnail_url: record.thumbnail_url ?? null,
    landing_url: record.landing_url ?? null,
  };
}

function toDetailed(record: DigitalNzRecord) {
  return {
    ...toConcise(record),
    description: record.description ?? null,
    creator: record.creator ?? [],
    subject: record.subject ?? [],
    tag: record.tag ?? [],
    usage: record.usage ?? [],
    copyright: record.copyright ?? [],
    language: record.language ?? [],
    is_commercial_use: record.is_commercial_use ?? null,
    source_url: record.source_url ?? null,
    large_thumbnail_url: record.large_thumbnail_url ?? null,
  };
}

export async function searchDigitalnzHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  if (!input.query && !input.category) {
    return toolError(
      "Provide at least a `query` (free-text) or `category` filter.",
      "Searching with neither would page through an unfiltered slice of DigitalNZ's 30M+ record corpus.",
    );
  }

  if (input.offset % input.limit !== 0) {
    return toolError(
      "`offset` must be a multiple of `limit`.",
      "DigitalNZ paginates by page number internally, not by arbitrary skip. Page through results using the `next_offset` this tool returns, keeping `limit` unchanged between calls.",
    );
  }

  try {
    const page = Math.floor(input.offset / input.limit) + 1;
    const { records, totalCount, facets } = await searchDigitalNzClient({
      ...(input.query ? { text: input.query } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.geo_bbox ? { geoBbox: input.geo_bbox } : {}),
      ...(input.sort !== "relevance" ? { sort: input.sort, direction: input.sort_direction } : {}),
      perPage: input.limit,
      page,
      includeFacets: input.include_facets,
    });

    const pageInfo = describePage({ returned: records.length, total_count: totalCount, offset: input.offset });
    const items = records.map((record) => selectFormat(input.response_format, toConcise(record), toDetailed(record)));

    return jsonResult({
      items,
      ...pageInfo,
      ...(facets ? { facets } : {}),
      notice: truncationNotice(input.offset + records.length, totalCount, "Narrow with `query`, `category`, or `geo_bbox`."),
      attribution: attribution("DigitalNZ", {
        url: "https://digitalnz.org/",
        license: "Varies by contributing partner — see each record's `rights` field",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
