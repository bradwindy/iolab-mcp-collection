import { decryptValue, encryptValue } from "./crypto.js";

/**
 * Minimal structural subset of D1Database/D1PreparedStatement we depend on.
 * The real Cloudflare D1Database satisfies this; tests use an in-memory fake.
 */
export interface D1LikeStatement {
  bind(...values: unknown[]): D1LikeStatement;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

export interface D1LikeDatabase {
  prepare(query: string): D1LikeStatement;
}

export type CredentialStatus = {
  keyName: string;
  isSet: boolean;
  updatedAt: string | null;
};

/** Encrypt and upsert one credential value for a given server. */
export async function setCredential(
  db: D1LikeDatabase,
  server: string,
  keyName: string,
  plaintextValue: string,
  encryptionKey: string,
): Promise<void> {
  const value = await encryptValue(plaintextValue, encryptionKey);
  const updatedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO credentials (server, key_name, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (server, key_name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(server, keyName, value, updatedAt)
    .run();
}

/** Fetch and decrypt one credential value. Returns null if it has not been set. */
export async function getCredential(
  db: D1LikeDatabase,
  server: string,
  keyName: string,
  encryptionKey: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM credentials WHERE server = ? AND key_name = ?`)
    .bind(server, keyName)
    .first<{ value: string }>();
  if (!row) return null;
  return decryptValue(row.value, encryptionKey);
}

/** Remove a credential (e.g. a user clearing a key from the portal). */
export async function deleteCredential(db: D1LikeDatabase, server: string, keyName: string): Promise<void> {
  await db.prepare(`DELETE FROM credentials WHERE server = ? AND key_name = ?`).bind(server, keyName).run();
}

/**
 * Report which of a server's required credentials are set, without ever decrypting
 * a value — used by the portal's dashboard/status views.
 */
export async function listCredentialStatus(
  db: D1LikeDatabase,
  server: string,
  requiredKeyNames: string[],
): Promise<CredentialStatus[]> {
  const { results } = await db
    .prepare(`SELECT key_name, updated_at FROM credentials WHERE server = ?`)
    .bind(server)
    .all<{ key_name: string; updated_at: string }>();
  const setMap = new Map(results.map((row) => [row.key_name, row.updated_at]));
  return requiredKeyNames.map((keyName) => ({
    keyName,
    isSet: setMap.has(keyName),
    updatedAt: setMap.get(keyName) ?? null,
  }));
}
