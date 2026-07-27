import { UpstreamHttpError } from "@iolab/mcp-kit";
import { WIKIDATA_HOST } from "../projects.js";
import { actionApi } from "./actionApi.js";
import { wikimediaFetch } from "./http.js";

export const SOURCE = "Wikidata";

const REST_BASE = `https://${WIKIDATA_HOST}/w/rest.php/wikibase/v1`;

/** An entity id the caller asked for that Wikidata does not have. */
export class EntityNotFoundError extends Error {
  constructor(public readonly entityId: string) {
    super(`Wikidata has no entity '${entityId}'.`);
    this.name = "EntityNotFoundError";
  }
}

export type EntitySearchHit = {
  id: string;
  label?: string;
  description?: string;
  match?: { type?: string; language?: string; text?: string };
  aliases?: string[];
};

/**
 * Search Wikidata for an entity by name.
 *
 * This uses the Action API rather than the Wikibase REST API on purpose. REST v1 has since grown
 * `/v1/search/items` and `/v1/suggest/items` — the older comment here claiming it has no search at
 * all is out of date — but neither offers `wbsearchentities`' `type` filter (items vs properties)
 * nor its `search-continue` offset, both of which this tool exposes.
 *
 * Note `wbsearchentities` matches **prefixes** of labels and aliases, not free text.
 */
export async function searchEntities(
  env: Env,
  params: { search: string; language: string; type: string; limit: number; offset: number },
): Promise<{ hits: EntitySearchHit[]; has_more: boolean; next_offset: number | null }> {
  const body = await actionApi<{ search?: EntitySearchHit[]; "search-continue"?: number }>(env, WIKIDATA_HOST, {
    action: "wbsearchentities",
    search: params.search,
    language: params.language,
    uselang: params.language,
    type: params.type,
    limit: params.limit,
    continue: params.offset,
  });

  const continueAt = body["search-continue"];
  return {
    hits: body.search ?? [],
    // `search-continue` is the offset of the next result; its absence is how the API signals the end.
    has_more: continueAt !== undefined,
    next_offset: continueAt ?? null,
  };
}

/** A property/value pair: a statement, one of its qualifiers, or one part of a reference. */
export type RestSnak = {
  property?: { id?: string; data_type?: string };
  value?: { type?: string; content?: unknown };
};

export type RestStatement = RestSnak & {
  id?: string;
  rank?: string;
  /**
   * An ordered array in REST v1 — the Action API's property-keyed map plus `qualifiers-order` is
   * already flattened for us. This is where `point in time` (P585) lives, without which a page of
   * `population` statements is 36 indistinguishable numbers.
   */
  qualifiers?: RestSnak[];
  /** REST flattens the Action API's `snaks`/`snaks-order` into `parts`. */
  references?: Array<{ hash?: string; parts?: RestSnak[] }>;
};

export type RestEntity = {
  id?: string;
  type?: string;
  labels?: Record<string, string>;
  descriptions?: Record<string, string>;
  aliases?: Record<string, string[]>;
  statements?: Record<string, RestStatement[]>;
  sitelinks?: Record<string, { title?: string; url?: string; badges?: string[] }>;
};

/**
 * Fetch one entity through the Wikibase REST API v1.
 *
 * v1 has been GA since November 2024 and is covered by Wikidata's Stable Interface Policy. Its
 * statement shape (`{property: {id, data_type}, value: {type, content}}`) is dramatically flatter
 * than the Action API's `mainsnak.datavalue.value` nesting, which is why reads go through it even
 * though search cannot.
 */
export async function fetchEntity(env: Env, entityId: string): Promise<RestEntity> {
  const kind = entityId.startsWith("P") ? "properties" : "items";
  const response = await wikimediaFetch(env, `${REST_BASE}/entities/${kind}/${encodeURIComponent(entityId)}`);
  if (response.status === 404) throw new EntityNotFoundError(entityId);
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return (await response.json()) as RestEntity;
}

/**
 * Look up display labels for a batch of entity ids.
 *
 * Uses `wbgetentities` rather than N REST calls because REST v1 has no batch route, and the Robot
 * policy caps an unauthenticated client at one concurrent Action API request — so N round trips is
 * the worst possible shape here. The API's own cap is 50 ids per request; callers must chunk.
 */
export const LABEL_BATCH_LIMIT = 50;

export type LabelResult = {
  labels: Record<string, string>;
  /** Ids whose label came from a fallback language rather than the one requested. */
  fallbacks: Record<string, string>;
};

export async function fetchLabels(env: Env, ids: string[], language: string): Promise<LabelResult> {
  if (ids.length === 0) return { labels: {}, fallbacks: {} };
  if (ids.length > LABEL_BATCH_LIMIT) {
    // Previously `ids.slice(0, LABEL_BATCH_LIMIT)`, which silently dropped the rest. Callers chunk;
    // failing loudly keeps a future caller from losing labels without noticing.
    throw new Error(`fetchLabels accepts at most ${LABEL_BATCH_LIMIT} ids per call, received ${ids.length}.`);
  }

  const body = await actionApi<{
    entities?: Record<string, { labels?: Record<string, { value?: string; language?: string; "for-language"?: string }> }>;
  }>(env, WIKIDATA_HOST, {
    action: "wbgetentities",
    ids: ids.join("|"),
    props: "labels",
    // Both are needed. Without `languagefallback` a language with no label for an id returns `{}`,
    // which is how a `language: "mi"` request degraded into a wall of bare Q-ids. With it, the entry
    // reports the language that actually served it via `language`, and marks itself with
    // `for-language`. Note the fallback target is not always English — Q3621064 falls back to `mul`,
    // Wikidata's multilingual-label pseudo-language.
    languages: language === "en" ? "en" : `${language}|en`,
    languagefallback: 1,
  });

  const labels: Record<string, string> = {};
  const fallbacks: Record<string, string> = {};
  for (const [id, entity] of Object.entries(body.entities ?? {})) {
    const entry = entity.labels?.[language] ?? entity.labels?.["en"];
    const value = entry?.value;
    if (!value) continue;
    labels[id] = value;
    const served = entry?.language;
    if (served !== undefined && served !== language) fallbacks[id] = served;
  }
  return { labels, fallbacks };
}

/**
 * Look up the "unit symbol" (P5061) for a batch of unit entities.
 *
 * A quantity carries its unit as an entity URI, and `+268021` with a bare Q-id is exactly as
 * unusable as `+268021` alone. The label gives "square kilometre"; P5061 gives "km²", which is what
 * belongs next to a number. One `wbgetentities` call covers every unit on the page.
 */
export async function fetchUnitSymbols(env: Env, ids: string[], language: string): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  // Throws rather than truncating, for the same reason fetchLabels does: a silently dropped id
  // renders its quantity without a unit and says nothing about it. Callers chunk.
  if (ids.length > LABEL_BATCH_LIMIT) {
    throw new Error(`fetchUnitSymbols accepts at most ${LABEL_BATCH_LIMIT} ids per call, received ${ids.length}.`);
  }
  const body = await actionApi<{
    entities?: Record<
      string,
      { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { text?: string; language?: string } } } }>> }
    >;
  }>(env, WIKIDATA_HOST, {
    action: "wbgetentities",
    ids: ids.join("|"),
    props: "claims",
  });

  const symbols: Record<string, string> = {};
  for (const [id, entity] of Object.entries(body.entities ?? {})) {
    const claims = entity.claims?.["P5061"] ?? [];
    const values = claims.flatMap((claim) => {
      const value = claim.mainsnak?.datavalue?.value;
      return value?.text === undefined ? [] : [{ text: value.text, language: value.language }];
    });
    // P5061 is multi-valued across languages; prefer the requested one, then English, then whatever
    // exists — the symbol is usually script-independent anyway ("km²").
    const chosen = values.find((value) => value.language === language) ?? values.find((value) => value.language === "en") ?? values[0];
    if (chosen !== undefined) symbols[id] = chosen.text;
  }
  return symbols;
}

/**
 * The human-facing wiki URL for an entity id.
 *
 * Properties live under a `Property:` namespace — confirmed live, `/wiki/P31` is a **404** while
 * `/wiki/Property:P31` is a 200 — so the naive `/wiki/{id}` form produces dead links for exactly
 * the ids `type: "property"` searches return.
 */
export function entityUrl(entityId: string): string {
  return entityId.toUpperCase().startsWith("P")
    ? `https://www.wikidata.org/wiki/Property:${entityId}`
    : `https://www.wikidata.org/wiki/${entityId}`;
}

