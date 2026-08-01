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

/**
 * Workers KV rejects any key longer than 512 **bytes** — `get()` and `put()` both fail, so an
 * over-long key breaks a tool before it reaches the upstream API rather than merely missing the
 * cache. Any key built from caller-supplied text of unbounded length must go through `cacheKey`.
 *
 * Lives here rather than in a server because two servers now need it: wikimedia-mcp (50 page titles
 * per call already overflow) and reddit-mcp (search queries are arbitrarily long).
 */
const MAX_KEY_BYTES = 512;

/** Headroom under the limit, so a key that squeaks under today doesn't break on a longer input. */
const SAFE_KEY_BYTES = 400;

const keyEncoder = new TextEncoder();

export function byteLength(value: string): number {
  return keyEncoder.encode(value).length;
}

/**
 * Build a cache key from a fixed prefix and a variable part, hashing the variable part when the
 * whole key would otherwise risk KV's limit. The prefix is always left readable so keys stay
 * greppable in practice.
 */
export async function cacheKey(prefix: string, variable: string): Promise<string> {
  const plain = `${prefix}:${variable}`;
  if (byteLength(plain) <= SAFE_KEY_BYTES) return plain;

  const digest = await crypto.subtle.digest("SHA-256", keyEncoder.encode(variable));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const hashed = `${prefix}:sha256-${hex}`;
  // A hashed key is prefix + 71 bytes; only an absurd prefix could still overflow, and silently
  // returning an unusable key would resurrect exactly the bug this helper exists to prevent.
  if (byteLength(hashed) > MAX_KEY_BYTES) {
    throw new Error(`Cache key prefix '${prefix}' is too long to hash into a valid Workers KV key.`);
  }
  return hashed;
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
