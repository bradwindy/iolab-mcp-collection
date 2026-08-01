/**
 * Workers KV rejects any key longer than 512 **bytes** — `get()` and `put()` both fail, so an
 * over-long key breaks a tool before it reaches the upstream API rather than merely missing the
 * cache. That is easy to hit here: `wikimedia_get_page_metadata` accepts 50 titles per call, and
 * 50 x "Kiwi (bird)" already exceeds the limit, as do 20 titles containing macrons (te reo Māori
 * titles cost two bytes per macron).
 *
 * So any key built from caller-supplied text of unbounded length goes through `cacheKey`, which
 * hashes the variable part once it would push the key over a safe threshold.
 *
 * The implementation moved to @iolab/mcp-kit when reddit-mcp needed the same guard for its
 * unbounded search queries; this module stays as the local name the tools here already import.
 */
export { byteLength, cacheKey } from "@iolab/mcp-kit";
