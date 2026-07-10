export interface CacheNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Cache-aside a slow-changing upstream call (dataset metadata, area-code lookups, etc.)
 * behind a Workers KV namespace. Corrupt or missing entries transparently refetch.
 */
export async function cached<T>(
  cache: CacheNamespace,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const existing = await cache.get(key);
  if (existing !== null) {
    try {
      return JSON.parse(existing) as T;
    } catch {
      // Corrupt cache entry: fall through and refetch.
    }
  }
  const value = await fetcher();
  await cache.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  return value;
}

export const CACHE_TTL = {
  /** Reference data that changes rarely: area codes, dataset schemas, station lists. */
  METADATA: 60 * 60 * 24,
  /** Data that refreshes hourly or so: daily counts, aggregate snapshots. */
  SLOW_MOVING: 60 * 30,
  /**
   * Near-real-time feeds: quakes, traffic, vehicle positions. Cache only to absorb bursts.
   * 60 is the floor, not a design choice: Workers KV's `put()` rejects any `expirationTtl` below
   * 60 seconds with a 400 (confirmed live: "Invalid expiration_ttl of 30. Expiration TTL must be
   * at least 60."), so this can never be set lower.
   */
  NEAR_REALTIME: 60,
} as const;
