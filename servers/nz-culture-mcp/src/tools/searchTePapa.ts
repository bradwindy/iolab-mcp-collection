import { z } from "zod";
import {
  attribution,
  describePage,
  jsonResult,
  limitParam,
  missingCredentialError,
  offsetParam,
  responseFormatParam,
  selectFormat,
  truncationNotice,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { getCredential } from "@iolab/credentials";
import { SERVER_SLUG, TE_PAPA_API_KEY } from "../constants.js";
import { searchTePapa as searchTePapaClient, type TePapaRecord } from "../clients/tepapa.js";

export const searchTePapaInputShape = {
  query: z
    .string()
    .min(1)
    .max(300)
    .describe(
      "Full-text search query. Supports Te Papa's search syntax: quoted phrases (\"new plymouth\"), " +
        "wildcards (aptery*), field search (title:crib), boolean operators (AND/OR), and ranges (id:[400 TO 500]).",
    ),
  collection: z
    .enum(["Object", "Specimen", "Agent", "Taxon", "Place", "Topic", "Category", "Publication"])
    .optional()
    .describe(
      "Restrict to one entity type. 'Object' covers physical objects and specimens' non-specimen siblings, " +
        "'Specimen' is natural-history specimens, 'Agent' covers both people and organisations, 'Publication' " +
        "covers documents/books.",
    ),
  limit: limitParam(100, 20),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchTePapaOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchTePapaInputShape);

function thumbnailOf(record: TePapaRecord): string | null {
  const representations = record.hasRepresentation as Array<{ thumbnailUrl?: string }> | undefined;
  return representations?.[0]?.thumbnailUrl ?? null;
}

function collectionLabelOf(record: TePapaRecord): string | null {
  const label = record.collectionLabel ?? record.collection;
  if (Array.isArray(label)) return (label[0] as string | undefined) ?? null;
  return (label as string | undefined) ?? null;
}

function toConcise(record: TePapaRecord) {
  return {
    id: record.id,
    type: record.type,
    title: (record.title as string | undefined) ?? (record.prefLabel as string | undefined) ?? null,
    collection: collectionLabelOf(record),
    url: (record.href as string | undefined) ?? null,
    rights_holder: (record.rightsHolder as string | undefined) ?? null,
    thumbnail_url: thumbnailOf(record),
  };
}

function toDetailed(record: TePapaRecord) {
  return record;
}

export async function searchTePapaHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const apiKey = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, TE_PAPA_API_KEY, env.ENCRYPTION_KEY);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, TE_PAPA_API_KEY, env.PORTAL_URL);

  try {
    const { results, totalCount } = await searchTePapaClient({
      apiKey,
      query: input.query,
      ...(input.collection ? { collection: input.collection } : {}),
      from: input.offset,
      size: input.limit,
      detailed: input.response_format === "detailed",
    });

    const page = describePage({ returned: results.length, total_count: totalCount, offset: input.offset });
    const items = results.map((record) => selectFormat(input.response_format, toConcise(record), toDetailed(record)));

    return jsonResult({
      items,
      ...page,
      notice: truncationNotice(input.offset + results.length, totalCount, "Narrow with `query` or the `collection` filter."),
      attribution: attribution("Museum of New Zealand Te Papa Tongarewa", {
        url: "https://collections.tepapa.govt.nz/",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
