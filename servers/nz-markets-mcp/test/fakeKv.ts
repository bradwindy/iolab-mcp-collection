/**
 * A minimal in-memory stand-in for a Workers KV namespace, satisfying @nz-mcp/mcp-kit's
 * CacheNamespace structural interface (get/put only — that's all `cached()` uses).
 */
export function createFakeKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  };
}
