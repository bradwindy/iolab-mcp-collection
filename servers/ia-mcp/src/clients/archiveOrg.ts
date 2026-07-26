import { UpstreamHttpError } from "@iolab/mcp-kit";
import { iaFetch } from "./http.js";

export const SOURCE = "archive.org";

/**
 * `advancedsearch.php`, not the Scrape API v1 — verified live, and it inverts the standard
 * advice (every source claims Scrape v1 replaced advancedsearch): Scrape's `cursor` never
 * advances (re-returns the identical first batch on every call), it ignores the `q` parameter
 * entirely (`q=moon` and `q=collection:nasa` both reported the same `total` with unrelated
 * results), and `count` has a minimum of 100 so it can't serve a small tool page directly.
 * `advancedsearch.php` behaved correctly on every check: distinct queries gave distinct
 * `numFound`, and with an explicit `sort[]` pagination advanced contiguously page over page.
 */
const ADVANCED_SEARCH_URL = "https://archive.org/advancedsearch.php";
const METADATA_URL = "https://archive.org/metadata";
const DOWNLOAD_URL = "https://archive.org/download";

/** Past this offset, advancedsearch.php's deep pagination becomes unreliable — surfaced as an actionable error. */
export const DEEP_PAGINATION_LIMIT = 10000;

export type SearchItem = {
  identifier: string;
  title?: string;
  creator?: string | string[];
  date?: string;
  mediatype?: string;
  collection?: string | string[];
};

export async function advancedSearch(
  env: Env,
  params: {
    query: string;
    mediatype?: string | undefined;
    collection?: string | undefined;
    yearFrom?: number | undefined;
    yearTo?: number | undefined;
    sort: string;
    rows: number;
    page: number;
  },
): Promise<{ numFound: number; docs: SearchItem[] }> {
  if ((params.page - 1) * params.rows >= DEEP_PAGINATION_LIMIT) {
    throw new DeepPaginationError();
  }

  const clauses = [params.query];
  if (params.mediatype) clauses.push(`mediatype:${params.mediatype}`);
  if (params.collection) clauses.push(`collection:${params.collection}`);
  if (params.yearFrom || params.yearTo) {
    const from = params.yearFrom ?? "*";
    const to = params.yearTo ?? "*";
    clauses.push(`year:[${from} TO ${to}]`);
  }

  const url = new URL(ADVANCED_SEARCH_URL);
  url.searchParams.set("q", clauses.join(" AND "));
  url.searchParams.set("output", "json");
  url.searchParams.set("rows", String(params.rows));
  url.searchParams.set("page", String(params.page));
  for (const field of ["identifier", "title", "creator", "date", "mediatype", "collection"]) {
    url.searchParams.append("fl[]", field);
  }
  // Always explicit — this repo's own pagination-stability rule (best-practices doc §4).
  // Verified live: with an explicit sort, pagination advances contiguously across pages;
  // relying on the implicit default risks the same silent duplicate/drop bug that motivated
  // the rule in the first place.
  url.searchParams.set("sort[]", params.sort);

  const response = await iaFetch(env, url);
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  const body = (await response.json()) as { response: { numFound: number; docs: SearchItem[] } };
  return body.response;
}

export class DeepPaginationError extends Error {
  constructor() {
    super("advancedsearch.php pagination is unreliable past roughly 10,000 rows deep.");
    this.name = "DeepPaginationError";
  }
}

export type ItemFile = {
  name: string;
  format?: string;
  size?: string;
  md5?: string;
  source?: string;
};

export type ItemMetadata = {
  identifier: string;
  metadata: Record<string, unknown>;
  files: ItemFile[];
  server?: string | undefined;
  dir?: string | undefined;
  /** Present on lending-restricted items — the metadata API itself is always public, unlike file downloads. */
  is_dark?: boolean | undefined;
};

/**
 * The raw shape of `GET /metadata/<id>` — confirmed live: there is no top-level `identifier`
 * field at all; it's nested at `metadata.identifier`. An item that doesn't exist responds 200
 * with `{}` (no `metadata` key), not a 404 or an error envelope — confirmed live too.
 */
type RawItemMetadataResponse = {
  metadata?: Record<string, unknown>;
  files?: ItemFile[];
  server?: string;
  dir?: string;
  is_dark?: boolean;
};

/** Thrown when the metadata API responds 200 with an empty `{}` body — archive.org's own signal for "no such item." */
export class ItemNotFoundError extends Error {
  constructor(public readonly identifier: string) {
    super(`No archive.org item found with identifier '${identifier}'.`);
    this.name = "ItemNotFoundError";
  }
}

export async function getItemMetadata(env: Env, identifier: string): Promise<ItemMetadata> {
  const response = await iaFetch(env, `${METADATA_URL}/${encodeURIComponent(identifier)}`);
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  const body = (await response.json()) as RawItemMetadataResponse;
  if (!body.metadata) throw new ItemNotFoundError(identifier);
  return {
    // metadata.identifier is normally present and matches the requested identifier exactly, but
    // fall back to the requested one rather than risk `undefined` reaching the tool's response —
    // this field must never be missing.
    identifier: typeof body.metadata.identifier === "string" ? body.metadata.identifier : identifier,
    metadata: body.metadata,
    files: body.files ?? [],
    server: body.server,
    dir: body.dir,
    is_dark: body.is_dark,
  };
}

const FAV_COLLECTION_PREFIX = "fav-";
const MAX_COLLECTIONS_RETURNED = 20;

/**
 * archive.org's `collection` field mixes real curated collections (e.g. "nasa", "prelinger")
 * with one `fav-<username>` pseudo-collection per user who has favorited the item — confirmed
 * live: a popular item like "nasa" carries 1,006 `collection` entries, 1,005 of them `fav-*`.
 * These carry no research value and, across a page of search results, can balloon a single tool
 * response into tens of thousands of array entries. Dropped unconditionally; the (rare) remainder
 * is capped as a defensive bound, not because real collection lists are expected to be long.
 */
export function filterCollections<T extends string | string[] | undefined>(collection: T): T {
  if (collection === undefined || typeof collection === "string") return collection;
  return collection.filter((c) => !c.startsWith(FAV_COLLECTION_PREFIX)).slice(0, MAX_COLLECTIONS_RETURNED) as T;
}

/** Thrown when a file download 401s — confirmed live: in-copyright lending items 401, public-domain items 200. */
export class LendingRestrictedError extends Error {
  constructor(public readonly identifier: string) {
    super(`Item '${identifier}' is lending-restricted; its files are not publicly downloadable.`);
    this.name = "LendingRestrictedError";
  }
}

/**
 * Finds this item's full-text file from its metadata `files[]` array. Deliberately never
 * constructs the filename by convention — confirmed live it's sometimes `<id>_djvu.txt`,
 * sometimes an arbitrary name (e.g. `b190w10.txt`). Prefers a `_djvu.txt` suffix (the OCR
 * pipeline's own naming for the primary extracted text) and falls back to any `.txt` file.
 */
export function findFullTextFile(files: ItemFile[]): ItemFile | undefined {
  return files.find((f) => f.name.endsWith("_djvu.txt")) ?? files.find((f) => f.name.endsWith(".txt"));
}

export async function downloadItemFile(env: Env, identifier: string, filename: string): Promise<string> {
  const response = await iaFetch(env, `${DOWNLOAD_URL}/${encodeURIComponent(identifier)}/${encodeURIComponent(filename)}`);
  if (response.status === 401) throw new LendingRestrictedError(identifier);
  if (!response.ok) throw new UpstreamHttpError(SOURCE, response);
  return response.text();
}
