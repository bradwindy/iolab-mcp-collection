/** In-memory fake satisfying CacheNamespace — same pattern used across this repo's other servers. */
export function createFakeCache() {
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

/** In-memory fake satisfying @iolab/credentials' D1LikeDatabase — empty by default (no IA S3 keys set). */
export function createFakeCredentialsDb() {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async run() {
          return {};
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
}

/** Builds a fake Env for ia-mcp tool tests — no upstream credentials configured, matching the
 * common case every tool must work fully in. */
export function fakeEnv(): Env {
  return {
    MCP_CACHE: createFakeCache(),
    CREDENTIALS_DB: createFakeCredentialsDb(),
    ENCRYPTION_KEY: "NOnV4EUJ4r07rvPzrNy6SGdvJPCoAJQL+j7i2004jpo=",
  } as unknown as Env;
}
