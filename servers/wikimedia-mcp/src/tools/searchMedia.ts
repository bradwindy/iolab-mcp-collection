import { z } from "zod";
import { attribution, describePage, jsonResult, limitParam, offsetParam, toolError, type ToolTextResult } from "@iolab/mcp-kit";
import { readAttribution, searchMedia } from "../clients/commons.js";
import { SEARCH_OFFSET_CEILING } from "../clients/wiki.js";
import { COMMONS_HOST } from "../projects.js";
import { mapCommonWikiError, attributionSchema } from "../toolSupport.js";

export const searchMediaInputShape = {
  query: z.string().min(1).describe("What the media should depict, e.g. 'kiwi bird' or 'Christchurch cathedral 1900'."),
  file_type: z
    .enum(["any", "bitmap", "drawing", "audio", "video"])
    .default("any")
    .describe("Restrict to one kind of file. 'bitmap' is photographs and scans; 'drawing' is SVG and other vector art."),
  limit: limitParam(50, 10),
  offset: offsetParam,
  thumbnail_width: z
    .number()
    .int()
    .min(50)
    .max(1000)
    .default(300)
    .describe("Requested thumbnail width in pixels. Commons rounds to a standard bucket, so the returned image can be wider than asked."),
};

export const searchMediaOutputShape = {
  files: z.array(
    z.object({
      title: z.string(),
      pageid: z.number().optional(),
      mime: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      size_bytes: z.number().optional(),
      file_url: z.string().optional(),
      thumbnail_url: z.string().optional(),
      description_url: z.string().optional(),
      license: z.string().optional(),
      artist: z.string().optional(),
    }),
  ),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(searchMediaInputShape);

export async function searchMediaHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  if (input.offset + input.limit > SEARCH_OFFSET_CEILING) {
    return toolError(
      `Commons search cannot page beyond ${SEARCH_OFFSET_CEILING} results (offset ${input.offset} + limit ${input.limit} exceeds it).`,
      "Narrow the query instead of paging further.",
    );
  }

  const search = input.file_type === "any" ? input.query : `filetype:${input.file_type} ${input.query}`;

  try {
    const { rows, total_hits } = await searchMedia(env, {
      search,
      limit: input.limit,
      offset: input.offset,
      thumbnailWidth: input.thumbnail_width,
    });

    const files = rows.map((row) => {
      const credit = readAttribution(row.info.extmetadata);
      return {
        title: row.title,
        ...(row.pageid !== undefined ? { pageid: row.pageid } : {}),
        ...(row.info.mime !== undefined ? { mime: row.info.mime } : {}),
        ...(row.info.width !== undefined ? { width: row.info.width } : {}),
        ...(row.info.height !== undefined ? { height: row.info.height } : {}),
        ...(row.info.size !== undefined ? { size_bytes: row.info.size } : {}),
        ...(row.info.url !== undefined ? { file_url: row.info.url } : {}),
        ...(row.info.thumburl !== undefined ? { thumbnail_url: row.info.thumburl } : {}),
        ...(row.info.descriptionurl !== undefined ? { description_url: row.info.descriptionurl } : {}),
        ...(credit.license !== undefined ? { license: credit.license } : {}),
        ...(credit.artist !== undefined ? { artist: credit.artist } : {}),
      };
    });

    const pageInfo = describePage({ returned: files.length, total_count: total_hits, offset: input.offset });

    return jsonResult({
      files,
      ...pageInfo,
      notice:
        files.length > 0
          ? "Licences vary per file. Call wikimedia_get_media_info before reusing one to get its full attribution requirements."
          : "",
      attribution: attribution("Wikimedia Commons", { url: `https://${COMMONS_HOST}/` }),
    });
  } catch (error) {
    const mapped = mapCommonWikiError(error, "Try broader search terms, or `file_type: \"any\"`.");
    if (mapped) return mapped;
    throw error;
  }
}
