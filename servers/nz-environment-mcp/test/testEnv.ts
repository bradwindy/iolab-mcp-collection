// Shared test helper — NOT a test file itself (no .test.ts suffix, vitest won't collect it).
// Builds a minimal fake `Env` satisfying what our tool handlers need: a KV-shaped cache
// namespace and a D1-shaped credentials store, without touching real Cloudflare bindings.
import { encryptValue } from "@iolab/credentials";
import { NIWA_API_KEY_NAME, SERVER_SLUG } from "../src/constants.js";

export const TEST_ENCRYPTION_KEY = "PW8FuEhIc2nI3+L8+1ofwFtFD7LSYEpeAWNzYxxTtxc=";

function createFakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  };
}

type CredentialRow = { value: string; updated_at: string };

function createFakeCredentialsDb(rows: Map<string, CredentialRow>) {
  return {
    prepare(query: string) {
      let boundArgs: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          boundArgs = args;
          return this;
        },
        async first<T>(): Promise<T | null> {
          if (/SELECT value FROM credentials/i.test(query)) {
            const [server, keyName] = boundArgs as [string, string];
            const row = rows.get(`${server}:${keyName}`);
            return (row ?? null) as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: [] };
        },
        async run(): Promise<unknown> {
          return {};
        },
      };
    },
  };
}

/**
 * Build a fake Env for tool-handler unit tests. Pass `niwaApiKey` to simulate a
 * configured credential; omit it to exercise the missing-credential path.
 */
export async function createFakeEnv(opts: { niwaApiKey?: string } = {}): Promise<Env> {
  const rows = new Map<string, CredentialRow>();
  if (opts.niwaApiKey !== undefined) {
    const encrypted = await encryptValue(opts.niwaApiKey, TEST_ENCRYPTION_KEY);
    rows.set(`${SERVER_SLUG}:${NIWA_API_KEY_NAME}`, { value: encrypted, updated_at: new Date().toISOString() });
  }

  return {
    MCP_SHARED_TOKEN: "test-shared-token",
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    MCP_CACHE: createFakeKv(),
    CREDENTIALS_DB: createFakeCredentialsDb(rows),
  } as unknown as Env;
}
