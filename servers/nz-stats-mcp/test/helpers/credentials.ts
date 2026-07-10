import { setCredential } from "@nz-mcp/credentials";

const CREATE_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS credentials (server TEXT NOT NULL, key_name TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (server, key_name))";

/**
 * Mirrors the production `credentials` table schema (see the nz-mcp-collection shared D1
 * database) inside the local test D1 instance. vitest-pool-workers isolates storage per test
 * *file*, not per test (Vitest 4), so CREDENTIALS_DB is NOT guaranteed empty here — this uses
 * `CREATE TABLE IF NOT EXISTS` so it's a no-op on later calls within the same file. Any test
 * that queries CREDENTIALS_DB — including ones exercising the "credential not set" path, where
 * getCredential's SELECT would otherwise hit "no such table" on the very first test in the
 * file — must still call this first.
 */
export async function ensureCredentialsTable(env: Env): Promise<void> {
  await env.CREDENTIALS_DB.exec(CREATE_TABLE_SQL);
}

/** Ensures the table exists, then seeds a subscription key value for this server. */
export async function seedSubscriptionKey(env: Env, key = "test-subscription-key"): Promise<void> {
  await ensureCredentialsTable(env);
  await setCredential(env.CREDENTIALS_DB, "nz-stats-mcp", "STATS_NZ_SUBSCRIPTION_KEY", key, env.ENCRYPTION_KEY);
}
