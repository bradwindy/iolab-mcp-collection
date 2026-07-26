import { generateEncryptionKey, setCredential, type D1LikeDatabase } from "@iolab/credentials";
import type { CacheNamespace } from "@iolab/mcp-kit";

/** In-memory fake satisfying the D1LikeDatabase surface @iolab/credentials depends on. */
export class FakeD1 implements D1LikeDatabase {
  rows = new Map<string, { server: string; key_name: string; value: string; updated_at: string }>();

  private rowKey(server: string, keyName: string): string {
    return `${server} ${keyName}`;
  }

  prepare(query: string) {
    const normalized = query.trim();
    return {
      bind: (...values: unknown[]) => this.bound(normalized, values),
      run: async () => this.exec(normalized, []),
      first: async <T>() => (await this.exec(normalized, [])).first as T | null,
      all: async <T>() => ({ results: (await this.exec(normalized, [])).all as T[] }),
    };
  }

  private bound(normalized: string, values: unknown[]) {
    return {
      bind: () => this.bound(normalized, values),
      run: async () => this.exec(normalized, values),
      first: async <T>() => (await this.exec(normalized, values)).first as T | null,
      all: async <T>() => ({ results: (await this.exec(normalized, values)).all as T[] }),
    };
  }

  private async exec(query: string, values: unknown[]): Promise<{ first: unknown; all: unknown[] }> {
    if (query.startsWith("INSERT INTO credentials")) {
      const [server, keyName, value, updatedAt] = values as [string, string, string, string];
      this.rows.set(this.rowKey(server, keyName), { server, key_name: keyName, value, updated_at: updatedAt });
      return { first: null, all: [] };
    }
    if (query.startsWith("SELECT value FROM credentials")) {
      const [server, keyName] = values as [string, string];
      const row = this.rows.get(this.rowKey(server, keyName));
      return { first: row ? { value: row.value } : null, all: [] };
    }
    if (query.startsWith("DELETE FROM credentials")) {
      const [server, keyName] = values as [string, string];
      this.rows.delete(this.rowKey(server, keyName));
      return { first: null, all: [] };
    }
    throw new Error(`FakeD1: unhandled query: ${query}`);
  }
}

/** In-memory fake satisfying the CacheNamespace surface @iolab/mcp-kit's cached() depends on. */
export class FakeKV implements CacheNamespace {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

export type FakeCredentials = { LINZ_API_KEY?: string; LINZ_BASEMAPS_API_KEY?: string };

/** Build a minimal fake Env with seeded credential(s), for tools that read from CREDENTIALS_DB. */
export async function buildFakeEnv(credentials: FakeCredentials = {}) {
  const db = new FakeD1();
  const encryptionKey = generateEncryptionKey();
  if (credentials.LINZ_API_KEY) {
    await setCredential(db, "nz-geo-mcp", "LINZ_API_KEY", credentials.LINZ_API_KEY, encryptionKey);
  }
  if (credentials.LINZ_BASEMAPS_API_KEY) {
    await setCredential(db, "nz-geo-mcp", "LINZ_BASEMAPS_API_KEY", credentials.LINZ_BASEMAPS_API_KEY, encryptionKey);
  }
  const env = {
    CREDENTIALS_DB: db as unknown,
    ENCRYPTION_KEY: encryptionKey,
    MCP_CACHE: new FakeKV() as unknown,
  } as Env;
  return { env, db };
}
