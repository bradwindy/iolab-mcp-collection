import { encryptValue } from "@iolab/credentials";
import type { D1LikeDatabase, D1LikeStatement } from "@iolab/credentials";

/** Base64 encoding of 32 zero bytes — a validly-shaped (but obviously not secret) AES-256-GCM key for tests. */
export const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** Minimal in-memory KV fake satisfying mcp-kit's CacheNamespace interface. */
export function fakeKv(): { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> } {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

/** Minimal in-memory D1 fake satisfying @iolab/credentials' D1LikeDatabase interface. */
function fakeCredentialsDb(rows: Map<string, string>): D1LikeDatabase {
  return {
    prepare(query: string): D1LikeStatement {
      let boundValues: unknown[] = [];
      const statement: D1LikeStatement = {
        bind(...values: unknown[]) {
          boundValues = values;
          return statement;
        },
        async run() {
          return undefined;
        },
        async first<T>() {
          if (/SELECT value FROM credentials/.test(query)) {
            const [server, keyName] = boundValues as [string, string];
            const value = rows.get(`${server}:${keyName}`);
            return (value ? ({ value } as T) : null) as T | null;
          }
          return null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
      return statement;
    },
  };
}

export type TestEnvOptions = {
  /** If provided, seeds the fake CREDENTIALS_DB with an encrypted AT_SUBSCRIPTION_KEY row. */
  atSubscriptionKey?: string;
};

/** Build a minimal fake `Env` sufficient for exercising a tool handler in isolation. */
export async function makeTestEnv(options: TestEnvOptions = {}): Promise<Env> {
  const rows = new Map<string, string>();
  if (options.atSubscriptionKey) {
    rows.set(
      "nz-transport-mcp:AT_SUBSCRIPTION_KEY",
      await encryptValue(options.atSubscriptionKey, TEST_ENCRYPTION_KEY),
    );
  }
  return {
    MCP_SHARED_TOKEN: "test-shared-token",
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    CREDENTIALS_DB: fakeCredentialsDb(rows),
    MCP_CACHE: fakeKv(),
  } as unknown as Env;
}
