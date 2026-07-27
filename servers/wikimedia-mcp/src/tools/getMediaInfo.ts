import { z } from "zod";
import { attribution, CACHE_TTL, cached, jsonResult, type ToolTextResult } from "@iolab/mcp-kit";
import { fetchMediaInfo, normaliseFileTitle, readAttribution } from "../clients/commons.js";
import { stripInlineHtml } from "../html.js";
import { COMMONS_HOST } from "../projects.js";
import { mapCommonWikiError, attributionSchema } from "../toolSupport.js";

export const getMediaInfoInputShape = {
  title: z
    .string()
    .min(1)
    .describe("File name, with or without the 'File:' prefix, e.g. 'Apteryx owenii 0.jpg'. Files live on Commons even when used on a local wiki."),
  thumbnail_width: z
    .number()
    .int()
    .min(50)
    .max(2000)
    .default(800)
    .describe("Requested thumbnail width in pixels. Commons rounds to a standard bucket, so `thumbnail_url` may be wider than requested."),
};

export const getMediaInfoOutputShape = {
  title: z.string(),
  pageid: z.number().optional(),
  mime: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  size_bytes: z.number().optional(),
  file_url: z.string().optional(),
  thumbnail_url: z.string().optional(),
  description_url: z.string().optional(),
  description: z.string().optional(),
  credit: z.object({
    artist: z.string().optional(),
    credit: z.string().optional(),
    license: z.string().optional(),
    license_url: z.string().optional(),
    usage_terms: z.string().optional(),
    attribution_required: z.boolean().optional(),
  }),
  notice: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getMediaInfoInputShape);

export async function getMediaInfoHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const title = normaliseFileTitle(input.title);

  try {
    // Deliberately NOT cached for a day: Commons permits overwriting a file in place under the
    // same title (https://commons.wikimedia.org/wiki/Commons:Overwriting_existing_files), which
    // changes the file URL, dimensions, and — the part that matters — its author and licence. This
    // response is what a caller cites when reusing the image, so serving day-old attribution is a
    // correctness problem, not a staleness nicety.
    const { title: resolvedTitle, pageid, info } = await cached(
      env.MCP_CACHE,
      `wikimedia:file:${input.thumbnail_width}:${title}`,
      CACHE_TTL.SLOW_MOVING,
      () => fetchMediaInfo(env, { title, thumbnailWidth: input.thumbnail_width }),
    );

    const credit = readAttribution(info.extmetadata);
    // ImageDescription is free-form HTML written by uploaders — strip it like the credit fields.
    const rawDescription = info.extmetadata?.["ImageDescription"]?.value;
    const description = rawDescription === undefined ? "" : stripInlineHtml(String(rawDescription));

    return jsonResult({
      title: resolvedTitle,
      ...(pageid !== undefined ? { pageid } : {}),
      ...(info.mime !== undefined ? { mime: info.mime } : {}),
      ...(info.width !== undefined ? { width: info.width } : {}),
      ...(info.height !== undefined ? { height: info.height } : {}),
      ...(info.size !== undefined ? { size_bytes: info.size } : {}),
      ...(info.url !== undefined ? { file_url: info.url } : {}),
      ...(info.thumburl !== undefined ? { thumbnail_url: info.thumburl } : {}),
      ...(info.descriptionurl !== undefined ? { description_url: info.descriptionurl } : {}),
      ...(description.length > 0 ? { description } : {}),
      credit,
      notice:
        credit.attribution_required === true
          ? `Reuse of this file requires attribution: credit ${credit.artist ?? "the author named on the file page"} under ${credit.license ?? "its stated licence"}.`
          : "",
      attribution: attribution("Wikimedia Commons", { url: `https://${COMMONS_HOST}/` }),
    });
  } catch (error) {
    const mapped = mapCommonWikiError(error, "Use wikimedia_search_media to find the exact file name.");
    if (mapped) return mapped;
    throw error;
  }
}
