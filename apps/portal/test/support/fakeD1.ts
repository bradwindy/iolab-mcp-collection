import type { D1LikeDatabase } from "@iolab/credentials";

/**
 * In-memory fake satisfying the D1LikeDatabase surface @iolab/credentials depends on —
 * same pattern as packages/credentials/test/store.test.ts. Lets route tests exercise the
 * real setCredential/getCredential/listCredentialStatus/deleteCredential functions (and
 * therefore real AES-256-GCM encryption) without a live D1 binding.
 */
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
    if (query.startsWith("SELECT key_name, updated_at FROM credentials")) {
      const [server] = values as [string];
      const all = [...this.rows.values()]
        .filter((row) => row.server === server)
        .map((row) => ({ key_name: row.key_name, updated_at: row.updated_at }));
      return { first: null, all };
    }
    throw new Error(`FakeD1: unhandled query: ${query}`);
  }
}

/** Matches the constants signed into test Access JWTs — see test/support/accessJwt.ts. */
export const TEST_ACCESS_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
export const TEST_ACCESS_AUD = "test-aud-tag";

/** Build a test Env. Loosely typed on purpose — Hono's `app.request(path, init, env)`
 * accepts `Bindings | {}`, so any shape is accepted; TypeScript inside route handlers still
 * sees the real `Env` type. */
export function testEnv(
  overrides: {
    credentialsDb?: FakeD1;
    encryptionKey?: string;
    sharedToken?: string;
    baseDomain?: string;
    accessEmail?: string;
  } = {},
) {
  return {
    CREDENTIALS_DB: overrides.credentialsDb ?? new FakeD1(),
    ENCRYPTION_KEY: overrides.encryptionKey ?? "NOnV4EUJ4r07rvPzrNy6SGdvJPCoAJQL+j7i2004jpo=",
    MCP_SHARED_TOKEN: overrides.sharedToken ?? "test-shared-token",
    BASE_DOMAIN: overrides.baseDomain ?? "example.com",
    ACCESS_EMAIL: overrides.accessEmail ?? "you@example.com",
    ACCESS_TEAM_DOMAIN: TEST_ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: TEST_ACCESS_AUD,
  };
}
