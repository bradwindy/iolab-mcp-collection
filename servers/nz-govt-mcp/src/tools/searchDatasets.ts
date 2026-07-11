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
import { searchDatasets as searchDatasetsClient, UpstreamActionError, type CkanPackage } from "../clients/datagovt.js";

export const searchDatasetsInputShape = {
  query: z.string().min(1).max(200).describe("Free-text search across dataset titles, descriptions, and tags."),
  limit: limitParam(50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchDatasetsOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchDatasetsInputShape);

function toConcise(pkg: CkanPackage) {
  return {
    id: pkg.name,
    title: pkg.title,
    organisation: pkg.organization?.title ?? null,
    num_resources: pkg.num_resources,
    license: pkg.license_title,
  };
}

function toDetailed(pkg: CkanPackage) {
  return {
    ...toConcise(pkg),
    ckan_id: pkg.id,
    notes: pkg.notes,
    tags: pkg.tags.map((tag) => tag.name),
    metadata_modified: pkg.metadata_modified,
    resources: pkg.resources.map((resource) => ({
      id: resource.id,
      name: resource.name,
      format: resource.format,
      datastore_active: resource.datastore_active,
    })),
  };
}

export async function searchDatasetsHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const { results, count } = await searchDatasetsClient({
      query: input.query,
      rows: input.limit,
      start: input.offset,
    });

    const page = describePage({ returned: results.length, total_count: count, offset: input.offset });
    const items = results.map((pkg) => selectFormat(input.response_format, toConcise(pkg), toDetailed(pkg)));

    return jsonResult({
      items,
      ...page,
      notice: truncationNotice(input.offset + results.length, count, "Narrow `query` or page with `offset`."),
      attribution: attribution("data.govt.nz catalogue", { url: "https://catalogue.data.govt.nz/" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    if (error instanceof UpstreamActionError) {
      return toolError(error.message, "Verify the query/id and retry; this is data.govt.nz's own error, not a network failure.");
    }
    throw error;
  }
}
