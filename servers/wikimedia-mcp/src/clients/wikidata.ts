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
 * This uses the Action API rather than the Wikibase REST API on purpose: REST v1 has **no search
 * route at all**, so `wbsearchentities` is the only way to get from a string to a Q-id.
 */
export async function searchEntities(
  env: Env,
  params: { search: string; language: string; type: string; limit: number; offset: number },
): Promise<{ hits: EntitySearchHit[]; has_more: boolean }> {
  const body = await actionApi<{ search?: EntitySearchHit[]; "search-continue"?: number }>(env, WIKIDATA_HOST, {
    action: "wbsearchentities",
    search: params.search,
    language: params.language,
    uselang: params.language,
    type: params.type,
    limit: params.limit,
    continue: params.offset,
  });

  return {
    hits: body.search ?? [],
    // `search-continue` is the offset of the next result; its absence is how the API signals the end.
    has_more: body["search-continue"] !== undefined,
  };
}

export type RestStatement = {
  id?: string;
  rank?: string;
  property?: { id?: string; data_type?: string };
  value?: { type?: string; content?: unknown };
  qualifiers?: unknown[];
  references?: unknown[];
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

export async function fetchLabels(env: Env, ids: string[], language: string): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const body = await actionApi<{
    entities?: Record<string, { labels?: Record<string, { value?: string }> }>;
  }>(env, WIKIDATA_HOST, {
    action: "wbgetentities",
    ids: ids.slice(0, LABEL_BATCH_LIMIT).join("|"),
    props: "labels",
    languages: language,
  });

  const labels: Record<string, string> = {};
  for (const [id, entity] of Object.entries(body.entities ?? {})) {
    const value = entity.labels?.[language]?.value;
    if (value) labels[id] = value;
  }
  return labels;
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

/** Wikidata entity ids referenced as a statement value, in the order they appear. */
export function collectReferencedIds(statements: RestStatement[]): string[] {
  const ids = new Set<string>();
  for (const statement of statements) {
    const content = statement.value?.content;
    if (typeof content === "string" && /^[QP]\d+$/.test(content)) ids.add(content);
  }
  return [...ids];
}
