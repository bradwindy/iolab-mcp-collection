/**
 * Empties the shared MCP_CACHE KV namespace.
 *
 * @cloudflare/vitest-pool-workers isolates storage per test *file* under Vitest 4 (isolated
 * per-test storage, and the `isolatedStorage`/`singleWorker` options, were removed when the
 * pool moved to Vitest 4 — see
 * https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/).
 * That means writes to KV (unlike the CREDENTIALS_DB table, which each test recreates with
 * `CREATE TABLE IF NOT EXISTS`) persist from one test to the next within the same file. Tools
 * in this server cache upstream responses in MCP_CACHE keyed on request params, so without
 * clearing it between tests, an earlier test's cached response silently satisfies a later
 * test's request and its fetch mock is never called. Call this in `afterEach` in any test file
 * that stubs `fetch` and exercises a tool that calls `cached()`.
 */
export async function clearCache(env: Env): Promise<void> {
  const { keys } = await env.MCP_CACHE.list();
  await Promise.all(keys.map((key) => env.MCP_CACHE.delete(key.name)));
}
