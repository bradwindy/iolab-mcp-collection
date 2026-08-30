import { decryptValue, encryptValue } from "./crypto.js";

/**
 * Thrown by getCredential when a stored credential exists but cannot be decrypted with this
 * worker's ENCRYPTION_KEY — in practice the value was (re-)encrypted under a different key, e.g.
 * after a key rotation, or by a deployment carrying a different ENCRYPTION_KEY secret. The message
 * is written for the MCP caller: tool handlers don't catch this, so the MCP SDK surfaces it as the
 * tool-error text, replacing the raw WebCrypto OperationError that leaked internals and gave the
 * caller nothing to act on.
 */
export class CredentialDecryptionError extends Error {
  constructor(
    public readonly server: string,
    public readonly keyName: string,
    options?: ErrorOptions,
  ) {
    super(
      `The stored credential '${keyName}' for ${server} could not be decrypted with this worker's ` +
        `ENCRYPTION_KEY — it was encrypted under a different key. Re-save the credential in the ` +
        `portal, or restore the ENCRYPTION_KEY it was saved with. Retrying will not help until one ` +
        `of those happens.`,
      options,
    );
    this.name = "CredentialDecryptionError";
  }
}

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

/**
 * Fetch and decrypt one credential value. Returns null if it has not been set; throws
 * CredentialDecryptionError if it is set but was encrypted under a different ENCRYPTION_KEY.
 */
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
  try {
    return await decryptValue(row.value, encryptionKey);
  } catch (err) {
    console.error(`[credentials] decryption failed for ${server}/${keyName}:`, err instanceof Error ? err.message : err);
    // Only an AES-GCM authentication failure (WebCrypto's OperationError) means "encrypted under a
    // different key" — importKey's own "must decode to 32 bytes" error for a missing/malformed
    // ENCRYPTION_KEY is more precise than this wrapper's advice (re-saving via the portal can't fix
    // a broken key the portal shares), so let everything else propagate unchanged.
    if (err instanceof Error && err.name === "OperationError") {
      throw new CredentialDecryptionError(server, keyName, { cause: err });
    }
    throw err;
  }
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
