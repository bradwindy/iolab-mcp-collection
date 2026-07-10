import { z } from "zod";
import {
  attribution,
  cached,
  CACHE_TTL,
  jsonResult,
  responseFormatParam,
  selectFormat,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@nz-mcp/mcp-kit";
import { getDigitalNzRecord as getDigitalNzRecordClient, type DigitalNzRecord } from "../clients/digitalnz.js";

export const getDigitalnzRecordInputShape = {
  record_id: z
    .number()
    .int()
    .positive()
    .describe("The record's numeric DigitalNZ id, as returned by nz_culture_search_digitalnz."),
  response_format: responseFormatParam,
};

export const getDigitalnzRecordOutputShape = {
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
  attribution: z.object({ source: z.string(), url: z.string().optional(), license: z.string().optional() }),
};

const inputSchema = z.object(getDigitalnzRecordInputShape);

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

/**
 * `env` is only needed for the KV cache — DigitalNZ metadata records change rarely, so caching
 * the raw upstream fetch (not the formatted response) lets one cache entry serve both concise
 * and detailed requests for the same id.
 */
export async function getDigitalnzRecordHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  try {
    const record = await cached(env.MCP_CACHE, `nz-culture:digitalnz:record:${input.record_id}`, CACHE_TTL.METADATA, () =>
      getDigitalNzRecordClient(input.record_id),
    );

    const data = selectFormat(input.response_format, toConcise(record), toDetailed(record));

    return jsonResult({
      ...data,
      attribution: attribution("DigitalNZ", {
        url: "https://digitalnz.org/",
        license: "Varies by contributing partner — see the `rights` field",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
