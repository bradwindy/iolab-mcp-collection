import { z } from "zod";
import { attribution, CACHE_TTL, cached, jsonResult, limitParam, offsetParam, paginate, toolError, type ToolTextResult } from "@iolab/mcp-kit";
import {
  collectReferencedIds,
  EntityNotFoundError,
  entityUrl,
  fetchEntity,
  fetchLabels,
  LABEL_BATCH_LIMIT,
  type RestStatement,
} from "../clients/wikidata.js";
import { serially } from "../clients/http.js";
import { mapCommonWikiError, attributionSchema } from "../toolSupport.js";

export const getEntityInputShape = {
  entity_id: z
    .string()
    .regex(/^[QP]\d+$/i, "Use a Wikidata id like 'Q42' (an item) or 'P31' (a property).")
    .describe("Wikidata entity id, e.g. 'Q43642'. Find one with wikimedia_search_entities, or read it from a page's `wikibase_item`."),
  properties: z
    .array(z.string().regex(/^P\d+$/i))
    .optional()
    .describe("Only return statements for these property ids, e.g. ['P31','P171']. Omit to return all (paginated)."),
  language: z.string().min(2).max(20).default("en").describe("Language for labels and descriptions, including the labels of referenced entities."),
  include_sitelinks: z
    .boolean()
    .default(false)
    .describe("Include the list of wikis with an article about this entity, with their titles and URLs. Popular entities have 100+ of these."),
  limit: limitParam(100, 40),
  offset: offsetParam,
};

export const getEntityOutputShape = {
  id: z.string(),
  label: z.string().optional(),
  description: z.string().optional(),
  aliases: z.array(z.string()),
  statements: z.array(
    z.object({
      property_id: z.string(),
      property_label: z.string().optional(),
      value: z.string(),
      /** Set when the value is another entity, so the caller can fetch it without re-parsing `value`. */
      value_entity_id: z.string().optional(),
      value_type: z.string().optional(),
      rank: z.string().optional(),
    }),
  ),
  sitelinks: z.array(z.object({ wiki: z.string(), title: z.string(), url: z.string().optional() })).optional(),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  url: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getEntityInputShape);

/** Render a Wikibase REST statement value as a string, resolving entity references to labels where known. */
function renderValue(statement: RestStatement, labels: Record<string, string>): { value: string; entityId?: string } {
  const content = statement.value?.content;
  if (statement.value?.type === "novalue") return { value: "(no value)" };
  if (statement.value?.type === "somevalue") return { value: "(unknown value)" };
  if (typeof content === "string") {
    if (/^[QP]\d+$/.test(content)) return { value: labels[content] ?? content, entityId: content };
    return { value: content };
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    // Time, quantity, and globe-coordinate values are objects; surface the field a reader wants
    // rather than a JSON blob, falling back to a compact serialisation for anything unrecognised.
    if (typeof record["time"] === "string") return { value: record["time"] };
    if (typeof record["amount"] === "string") return { value: record["amount"] };
    if (typeof record["text"] === "string") return { value: record["text"] };
    if (typeof record["latitude"] === "number" && typeof record["longitude"] === "number") {
      return { value: `${record["latitude"]}, ${record["longitude"]}` };
    }
    return { value: JSON.stringify(content) };
  }
  return { value: content === undefined || content === null ? "" : String(content) };
}

export async function getEntityHandler(rawInput: unknown, env: Env): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);
  const entityId = input.entity_id.toUpperCase();
  const wanted = input.properties?.map((property) => property.toUpperCase());

  try {
    // No language in the key: fetchEntity takes none and always returns the full multi-language
    // entity, with language filtering applied in memory afterwards. Keying by language would store
    // byte-identical copies under one key per language requested.
    const entity = await cached(env.MCP_CACHE, `wikimedia:entity:${entityId}`, CACHE_TTL.SLOW_MOVING, () => fetchEntity(env, entityId));

    const grouped = Object.entries(entity.statements ?? {}).filter(([propertyId]) => wanted === undefined || wanted.includes(propertyId));
    if (wanted !== undefined && grouped.length === 0) {
      return toolError(
        `${entityId} has no statements for ${wanted.join(", ")}.`,
        "Call this tool again without `properties` to see which properties it does have.",
      );
    }

    const flat = grouped.flatMap(([propertyId, statements]) => statements.map((statement) => ({ propertyId, statement })));
    const page = paginate(flat, { limit: input.limit, offset: input.offset }, { maxLimit: 100, defaultLimit: 40 });

    // Only the statements actually being returned need labels resolving, which usually keeps this
    // to a single batch even for an entity with hundreds of statements. When it doesn't, the ids are
    // chunked rather than truncated: the tool's whole promise is readable labels instead of bare
    // Q-ids, so dropping everything past the 50-id batch cap would quietly break it on exactly the
    // dense entities where it matters most. Chunks run serially — the Action API's unauthenticated
    // concurrency limit is 1.
    const referenced = collectReferencedIds(page.items.map((row) => row.statement));
    const propertyIds = [...new Set(page.items.map((row) => row.propertyId))];
    const idsToLabel = [...new Set([...propertyIds, ...referenced])];
    const batches: Array<() => Promise<Record<string, string>>> = [];
    for (let start = 0; start < idsToLabel.length; start += LABEL_BATCH_LIMIT) {
      const chunk = idsToLabel.slice(start, start + LABEL_BATCH_LIMIT);
      batches.push(() => fetchLabels(env, chunk, input.language));
    }
    const labels = Object.assign({}, ...(await serially(batches))) as Record<string, string>;

    const statements = page.items.map(({ propertyId, statement }) => {
      const rendered = renderValue(statement, labels);
      return {
        property_id: propertyId,
        ...(labels[propertyId] !== undefined ? { property_label: labels[propertyId] } : {}),
        value: rendered.value,
        ...(rendered.entityId !== undefined ? { value_entity_id: rendered.entityId } : {}),
        ...(statement.property?.data_type !== undefined ? { value_type: statement.property.data_type } : {}),
        ...(statement.rank !== undefined ? { rank: statement.rank } : {}),
      };
    });

    return jsonResult({
      id: entity.id ?? entityId,
      ...(entity.labels?.[input.language] !== undefined ? { label: entity.labels[input.language] } : {}),
      ...(entity.descriptions?.[input.language] !== undefined ? { description: entity.descriptions[input.language] } : {}),
      aliases: entity.aliases?.[input.language] ?? [],
      statements,
      ...(input.include_sitelinks
        ? {
            sitelinks: Object.entries(entity.sitelinks ?? {}).map(([wiki, link]) => ({
              wiki,
              title: link.title ?? "",
              ...(link.url !== undefined ? { url: link.url } : {}),
            })),
          }
        : {}),
      total_count: page.total_count,
      has_more: page.has_more,
      next_offset: page.next_offset,
      url: entityUrl(entityId),
      attribution: attribution("Wikidata", { license: "CC0 1.0", url: "https://www.wikidata.org/" }),
    });
  } catch (error) {
    if (error instanceof EntityNotFoundError) {
      return toolError(error.message, "Find the right id with wikimedia_search_entities.");
    }
    const mapped = mapCommonWikiError(error, "Find the right id with wikimedia_search_entities.");
    if (mapped) return mapped;
    throw error;
  }
}
