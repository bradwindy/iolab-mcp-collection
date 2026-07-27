/**
 * Workers KV rejects any key longer than 512 **bytes** — `get()` and `put()` both fail, so an
 * over-long key breaks a tool before it reaches the upstream API rather than merely missing the
 * cache. That is easy to hit here: `wikimedia_get_page_metadata` accepts 50 titles per call, and
 * 50 x "Kiwi (bird)" already exceeds the limit, as do 20 titles containing macrons (te reo Māori
 * titles cost two bytes per macron).
 *
 * So any key built from caller-supplied text of unbounded length goes through `cacheKey`, which
 * hashes the variable part once it would push the key over a safe threshold.
 */

/** KV's hard limit. */
const MAX_KEY_BYTES = 512;

/** Headroom under the limit, so a key that squeaks under today doesn't break on a longer title. */
const SAFE_KEY_BYTES = 400;

const encoder = new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Build a cache key from a fixed prefix and a variable part, hashing the variable part when the
 * whole key would otherwise risk KV's limit. The prefix is always left readable so keys stay
 * greppable in practice.
 */
export async function cacheKey(prefix: string, variable: string): Promise<string> {
  const plain = `${prefix}:${variable}`;
  if (byteLength(plain) <= SAFE_KEY_BYTES) return plain;

  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(variable));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const hashed = `${prefix}:sha256-${hex}`;
  // A hashed key is prefix + 71 bytes; only an absurd prefix could still overflow, and silently
  // returning an unusable key would resurrect exactly the bug this module exists to prevent.
  if (byteLength(hashed) > MAX_KEY_BYTES) {
    throw new Error(`Cache key prefix '${prefix}' is too long to hash into a valid Workers KV key.`);
  }
  return hashed;
}
