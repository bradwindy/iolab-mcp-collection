import { z } from "zod";
import {
  attribution,
  cached,
  CACHE_TTL,
  jsonResult,
  missingCredentialError,
  responseFormatParam,
  selectFormat,
  UpstreamHttpError,
  upstreamError,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { getCredential } from "@iolab/credentials";
import { SERVER_SLUG, TE_PAPA_API_KEY } from "../constants.js";
import { getTePapaItem as getTePapaItemClient, TE_PAPA_ITEM_PATHS, type TePapaRecord } from "../clients/tepapa.js";

export const getTePapaItemInputShape = {
  resource_type: z
    .enum(TE_PAPA_ITEM_PATHS)
    .describe(
      "Which Te Papa resource collection the id belongs to — ids are only unique WITHIN a resource type, " +
        "not globally. Map from nz_culture_search_te_papa's `type` field: Object/Specimen -> 'object', " +
        "Person/Organisation -> 'agent', Place -> 'place', Taxon -> 'taxon', Publication -> 'document', " +
        "Topic -> 'topic', Category -> 'category'. 'media', 'group', and 'fieldcollection' are embedded " +
        "sub-records (an item's images, a taxonomic/agent grouping, a collecting event) referenced from " +
        "other items' fields rather than returned directly by search.",
    ),
  id: z
    .number()
    .int()
    .positive()
    .describe("The item's numeric id, as returned by nz_culture_search_te_papa or a related-record link on another item."),
  response_format: responseFormatParam,
};

export const getTePapaItemOutputShape = {
  id: z.number(),
  type: z.string(),
  title: z.string().nullable(),
  collection: z.string().nullable(),
  url: z.string().nullable(),
  rights_holder: z.string().nullable(),
  thumbnail_url: z.string().nullable(),
  record: z.record(z.string(), z.unknown()).optional(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(getTePapaItemInputShape);

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
  return { ...toConcise(record), record };
}

/**
 * `env` supplies both the D1-backed credential lookup (Te Papa requires an API key) and the KV
 * cache — collection records change rarely, so one cache entry covers concise and detailed alike.
 */
export async function getTePapaItemHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  const apiKey = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, TE_PAPA_API_KEY, env.ENCRYPTION_KEY);
  if (!apiKey) return missingCredentialError(SERVER_SLUG, TE_PAPA_API_KEY, env.PORTAL_URL);

  try {
    const record = await cached(
      env.MCP_CACHE,
      `nz-culture:tepapa:${input.resource_type}:${input.id}`,
      CACHE_TTL.METADATA,
      () => getTePapaItemClient({ apiKey, resourcePath: input.resource_type, id: input.id }),
    );

    const data = selectFormat(input.response_format, toConcise(record), toDetailed(record));

    return jsonResult({
      ...data,
      attribution: attribution("Museum of New Zealand Te Papa Tongarewa", {
        url: "https://collections.tepapa.govt.nz/",
      }),
    });
  } catch (error) {
    if (error instanceof UpstreamHttpError) return upstreamError(error.source, error.response);
    throw error;
  }
}
