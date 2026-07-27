import { z } from "zod";
import { attribution, CACHE_TTL, cached, jsonResult, limitParam, offsetParam, paginate, toolError, type ToolTextResult } from "@iolab/mcp-kit";
import {
  EntityNotFoundError,
  entityUrl,
  fetchEntity,
  fetchLabels,
  fetchUnitSymbols,
  LABEL_BATCH_LIMIT,
  type LabelResult,
  type RestSnak,
} from "../clients/wikidata.js";
import { collectUnitIds, collectValueIds, renderValue } from "../wikidataValues.js";
import { serially } from "../clients/http.js";
import { mapCommonWikiError, attributionSchema } from "../toolSupport.js";

/** Declared once so the advertised limit and the enforced limit cannot drift apart. */
const STATEMENT_BOUNDS = { maxLimit: 100, defaultLimit: 40 } as const;

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
  include_references: z
    .boolean()
    .default(false)
    .describe("Include each statement's sources — the 'stated in', 'reference URL' and 'retrieved' values Wikidata records for it."),
  include_sitelinks: z
    .boolean()
    .default(false)
    .describe(
      "Include the wikis with an article about this entity. Paged separately from statements via " +
        "`sitelinks_limit`/`sitelinks_offset`, because a country has 300+ of them.",
    ),
  sitelinks_limit: z.number().int().min(1).max(100).default(25).describe("Max sitelinks to return (1-100, default 25)."),
  sitelinks_offset: z.number().int().min(0).default(0).describe("Number of sitelinks to skip, for paging through them."),
  limit: limitParam(STATEMENT_BOUNDS.maxLimit, STATEMENT_BOUNDS.defaultLimit),
  offset: offsetParam,
};

/** A qualifier or reference part: the same property/value pair a statement is, minus the ranking. */
const qualifierSchema = z.object({
  property_id: z.string().optional(),
  property_label: z.string().optional(),
  value: z.string(),
  entity_id: z.string().optional(),
  precision: z.number().optional(),
  precision_label: z.string().optional(),
  calendar_model: z.string().optional(),
  unit_id: z.string().optional(),
  upper_bound: z.string().optional(),
  lower_bound: z.string().optional(),
  language: z.string().optional(),
  globe: z.string().optional(),
});

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
      /** Time values: 9 means the value is significant to the year only, 10 the month, 11 the day. */
      precision: z.number().optional(),
      precision_label: z.string().optional(),
      calendar_model: z.string().optional(),
      /** Quantity values. Absent `unit_id` means the quantity is unitless. */
      unit_id: z.string().optional(),
      upper_bound: z.string().optional(),
      lower_bound: z.string().optional(),
      /** Monolingual text values: which language the text is in. */
      language: z.string().optional(),
      globe: z.string().optional(),
      /**
       * The statement's qualifiers — `point in time`, `determination method` and so on. Without
       * these, repeated statements of the same property are indistinguishable from each other.
       */
      qualifiers: z.array(qualifierSchema).optional(),
      references: z.array(z.object({ hash: z.string().optional(), parts: z.array(qualifierSchema) })).optional(),
    }),
  ),
  /** Ids whose label came from a fallback language, keyed to the language that supplied it. */
  label_fallbacks: z.record(z.string(), z.string()).optional(),
  /** Ids with no label in the requested language or its fallbacks; their `value` is a bare id. */
  labels_missing: z.array(z.string()).optional(),
  sitelinks: z.array(z.object({ wiki: z.string(), title: z.string(), url: z.string().optional() })).optional(),
  sitelinks_total: z.number().optional(),
  sitelinks_next_offset: z.number().nullable().optional(),
  /** Counts statements only — matching `limit`/`offset`. Sitelinks have their own total. */
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  url: z.string(),
  attribution: attributionSchema,
};

const inputSchema = z.object(getEntityInputShape);


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
    const page = paginate(flat, { limit: input.limit, offset: input.offset }, STATEMENT_BOUNDS);

    // Only the statements actually being returned need labels resolving, which usually keeps this
    // to a single batch even for an entity with hundreds of statements. When it doesn't, the ids are
    // chunked rather than truncated: the tool's whole promise is readable labels instead of bare
    // Q-ids, so dropping everything past the 50-id batch cap would quietly break it on exactly the
    // dense entities where it matters most. Chunks run serially — the Action API's unauthenticated
    // concurrency limit is 1.
    const referenced = page.items.flatMap((row) => collectValueIds(row.statement, input.include_references));
    const propertyIds = [
      ...new Set([
        ...page.items.map((row) => row.propertyId),
        // Qualifier properties need labels too, or `P585` is returned with no gloss.
        ...page.items.flatMap((row) => (row.statement.qualifiers ?? []).flatMap((q) => (q.property?.id === undefined ? [] : [q.property.id]))),
        ...(input.include_references
          ? page.items.flatMap((row) =>
              (row.statement.references ?? []).flatMap((reference) =>
                (reference.parts ?? []).flatMap((part) => (part.property?.id === undefined ? [] : [part.property.id])),
              ),
            )
          : []),
      ]),
    ];
    const idsToLabel = [...new Set([...propertyIds, ...referenced])];
    const batches: Array<() => Promise<LabelResult>> = [];
    for (let start = 0; start < idsToLabel.length; start += LABEL_BATCH_LIMIT) {
      const chunk = idsToLabel.slice(start, start + LABEL_BATCH_LIMIT);
      batches.push(() => fetchLabels(env, chunk, input.language));
    }
    const results = await serially(batches);
    const labels: Record<string, string> = Object.assign({}, ...results.map((result) => result.labels));
    const labelFallbacks: Record<string, string> = Object.assign({}, ...results.map((result) => result.fallbacks));

    // Units are resolved from P5061 rather than their label: "268021 km²" beats "268021 square
    // kilometre", and both beat the bare "+268021" this used to return.
    const unitIds = [
      ...new Set(page.items.flatMap((row) => collectUnitIds(row.statement))),
    ];
    const unitBatches: Array<() => Promise<Record<string, string>>> = [];
    for (let start = 0; start < unitIds.length; start += LABEL_BATCH_LIMIT) {
      const chunk = unitIds.slice(start, start + LABEL_BATCH_LIMIT);
      unitBatches.push(() => fetchUnitSymbols(env, chunk, input.language));
    }
    const unitSymbols: Record<string, string> = Object.assign({}, ...(await serially(unitBatches)));

    const renderSnak = (snak: RestSnak) => {
      const rendered = renderValue(snak, labels, unitSymbols);
      const propertyId = snak.property?.id;
      return {
        ...(propertyId !== undefined ? { property_id: propertyId } : {}),
        ...(propertyId !== undefined && labels[propertyId] !== undefined ? { property_label: labels[propertyId] } : {}),
        ...rendered,
      };
    };

    const statements = page.items.map(({ propertyId, statement }) => {
      const rendered = renderValue(statement, labels, unitSymbols);
      const qualifiers = (statement.qualifiers ?? []).map(renderSnak);
      // Grouped by source, not flattened: a statement with two references each carrying `stated in`
      // + `retrieved` would otherwise return four undifferentiated rows. Skipped entirely when not
      // requested — the labels those parts need are not fetched on that path either.
      const references = input.include_references
        ? (statement.references ?? []).map((reference) => ({
            ...(reference.hash !== undefined ? { hash: reference.hash } : {}),
            parts: (reference.parts ?? []).map(renderSnak),
          }))
        : [];
      return {
        property_id: propertyId,
        ...(labels[propertyId] !== undefined ? { property_label: labels[propertyId] } : {}),
        value: rendered.value,
        ...(rendered.entity_id !== undefined ? { value_entity_id: rendered.entity_id } : {}),
        ...(statement.property?.data_type !== undefined ? { value_type: statement.property.data_type } : {}),
        ...(statement.rank !== undefined ? { rank: statement.rank } : {}),
        ...(rendered.precision !== undefined ? { precision: rendered.precision } : {}),
        ...(rendered.precision_label !== undefined ? { precision_label: rendered.precision_label } : {}),
        ...(rendered.calendar_model !== undefined ? { calendar_model: rendered.calendar_model } : {}),
        ...(rendered.unit_id !== undefined ? { unit_id: rendered.unit_id } : {}),
        ...(rendered.upper_bound !== undefined ? { upper_bound: rendered.upper_bound } : {}),
        ...(rendered.lower_bound !== undefined ? { lower_bound: rendered.lower_bound } : {}),
        ...(rendered.language !== undefined ? { language: rendered.language } : {}),
        ...(rendered.globe !== undefined ? { globe: rendered.globe } : {}),
        ...(qualifiers.length > 0 ? { qualifiers } : {}),
        ...(references.length > 0 ? { references } : {}),
      };
    });

    const allSitelinks = Object.entries(entity.sitelinks ?? {});
    const sitelinkPage = input.include_sitelinks
      ? allSitelinks.slice(input.sitelinks_offset, input.sitelinks_offset + input.sitelinks_limit)
      : [];
    const missingLabels = idsToLabel.filter((id) => labels[id] === undefined);

    return jsonResult({
      id: entity.id ?? entityId,
      ...(entity.labels?.[input.language] !== undefined ? { label: entity.labels[input.language] } : {}),
      ...(entity.descriptions?.[input.language] !== undefined ? { description: entity.descriptions[input.language] } : {}),
      aliases: entity.aliases?.[input.language] ?? [],
      statements,
      ...(Object.keys(labelFallbacks).length > 0 ? { label_fallbacks: labelFallbacks } : {}),
      ...(missingLabels.length > 0 ? { labels_missing: missingLabels } : {}),
      ...(input.include_sitelinks
        ? {
            sitelinks: sitelinkPage.map(([wiki, link]) => ({
              wiki,
              title: link.title ?? "",
              ...(link.url !== undefined ? { url: link.url } : {}),
            })),
            sitelinks_total: allSitelinks.length,
            sitelinks_next_offset:
              input.sitelinks_offset + sitelinkPage.length < allSitelinks.length ? input.sitelinks_offset + sitelinkPage.length : null,
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
