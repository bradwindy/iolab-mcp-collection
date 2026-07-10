import { z } from "zod";
import { attribution, jsonResult, UpstreamHttpError, upstreamError, type ToolTextResult } from "@nz-mcp/mcp-kit";
import { getDataset as getDatasetClient } from "../clients/datagovt.js";

export const getDatasetInputShape = {
  id_or_slug: z
    .string()
    .min(1)
    .describe("The dataset's CKAN id (UUID) or URL slug, as returned by nz_govt_search_datasets."),
};

export const getDatasetOutputShape = {
  id: z.string(),
  title: z.string(),
  organisation: z.string().nullable(),
  notes: z.string().nullable(),
  license: z.string().nullable(),
  license_url: z.string().nullable(),
  metadata_modified: z.string(),
  tags: z.array(z.string()),
  resources: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      format: z.string().nullable(),
      url: z.string(),
      datastore_active: z.boolean(),
    }),
  ),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getDatasetInputShape);

export async function getDatasetHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const pkg = await getDatasetClient(input.id_or_slug);

    return jsonResult({
      id: pkg.name,
      title: pkg.title,
      organisation: pkg.organization?.title ?? null,
      notes: pkg.notes,
      license: pkg.license_title,
      license_url: pkg.license_url,
      metadata_modified: pkg.metadata_modified,
      tags: pkg.tags.map((tag) => tag.name),
      resources: pkg.resources.map((resource) => ({
        id: resource.id,
        name: resource.name,
        format: resource.format,
        url: resource.url,
        datastore_active: resource.datastore_active,
      })),
      attribution: attribution("data.govt.nz catalogue", { url: "https://catalogue.data.govt.nz/" }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
