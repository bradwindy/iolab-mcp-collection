export type PaginationParams = {
  limit?: number;
  offset?: number;
};

export type PaginationOptions = {
  defaultLimit?: number;
  maxLimit?: number;
};

export type PaginatedResult<T> = {
  items: T[];
  total_count: number;
  has_more: boolean;
  next_offset: number | null;
};

export type PageDescriptor = {
  total_count: number;
  has_more: boolean;
  next_offset: number | null;
};

/** Clamp a caller-supplied `limit` into [1, maxLimit], defaulting when absent or invalid. */
export function normalizeLimit(limit: number | undefined, opts: PaginationOptions = {}): number {
  const defaultLimit = opts.defaultLimit ?? 20;
  const maxLimit = opts.maxLimit ?? 50;
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return defaultLimit;
  return Math.min(Math.floor(limit), maxLimit);
}

/** Clamp a caller-supplied `offset` to a non-negative integer, defaulting to 0. */
export function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

/**
 * Paginate an in-memory array the server already fetched in full.
 * Prefer `describePage` when the upstream API paginates server-side.
 */
export function paginate<T>(
  allItems: T[],
  params: PaginationParams,
  opts: PaginationOptions = {},
): PaginatedResult<T> {
  const limit = normalizeLimit(params.limit, opts);
  const offset = normalizeOffset(params.offset);
  const total_count = allItems.length;
  const items = allItems.slice(offset, offset + limit);
  const has_more = offset + items.length < total_count;
  return {
    items,
    total_count,
    has_more,
    next_offset: has_more ? offset + items.length : null,
  };
}

/** Build the pagination metadata fields when the upstream API already returned one page. */
export function describePage(opts: {
  returned: number;
  total_count: number;
  offset: number;
}): PageDescriptor {
  const has_more = opts.offset + opts.returned < opts.total_count;
  return {
    total_count: opts.total_count,
    has_more,
    next_offset: has_more ? opts.offset + opts.returned : null,
  };
}
