import { z } from "zod";
import {
  attribution,
  describePage,
  jsonResult,
  limitParam,
  offsetParam,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { filterCollections, getItemMetadata, ItemNotFoundError } from "../clients/archiveOrg.js";

export const getItemInputShape = {
  identifier: z.string().min(1).describe("The archive.org item identifier, e.g. 'nasa' or 'hobbitortherebac00tolk_2'."),
  files_limit: limitParam(200, 50),
  files_offset: offsetParam,
};

export const getItemOutputShape = {
  identifier: z.string(),
  title: z.string().optional(),
  creator: z.union([z.string(), z.array(z.string())]).optional(),
  date: z.string().optional(),
  description: z.string().optional(),
  subjects: z.union([z.string(), z.array(z.string())]).optional(),
  collections: z.union([z.string(), z.array(z.string())]).optional(),
  licenseurl: z.string().optional(),
  is_restricted: z.boolean(),
  details_url: z.string(),
  files: z.array(z.object({ name: z.string(), format: z.string().optional(), size: z.string().optional(), md5: z.string().optional() })),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getItemInputShape);

export async function getItemHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const item = await getItemMetadata(env, input.identifier);
    const meta = item.metadata as Record<string, unknown>;

    const allFiles = item.files ?? [];
    const filesPage = allFiles.slice(input.files_offset, input.files_offset + input.files_limit);
    const pageInfo = describePage({ returned: filesPage.length, total_count: allFiles.length, offset: input.files_offset });

    return jsonResult({
      identifier: item.identifier,
      title: typeof meta.title === "string" ? meta.title : undefined,
      creator: meta.creator as string | string[] | undefined,
      date: typeof meta.date === "string" ? meta.date : undefined,
      description: typeof meta.description === "string" ? meta.description : undefined,
      subjects: meta.subject as string | string[] | undefined,
      collections: filterCollections(meta.collection as string | string[] | undefined),
      licenseurl: typeof meta.licenseurl === "string" ? meta.licenseurl : undefined,
      // The metadata API is public even for lending-restricted items; `is_dark` is archive.org's
      // own flag for that — surfaced here so a caller knows before hitting a 401 on file download.
      is_restricted: Boolean(item.is_dark),
      details_url: `https://archive.org/details/${item.identifier}`,
      files: filesPage.map((f) => ({ name: f.name, format: f.format, size: f.size, md5: f.md5 })),
      ...pageInfo,
      attribution: attribution("archive.org", { url: `https://archive.org/details/${item.identifier}` }),
    });
  } catch (error) {
    if (error instanceof ItemNotFoundError) {
      return { content: [{ type: "text", text: `${error.message} Check the identifier with ia_search_items.` }], isError: true };
    }
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
