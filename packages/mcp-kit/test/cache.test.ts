import { describe, expect, it, vi } from "vitest";
import { cached, type CacheNamespace } from "../src/cache.js";

function memoryCache(): CacheNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value);
    },
  };
}

describe("cached", () => {
  it("calls the fetcher on a miss and stores the result", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn().mockResolvedValue({ value: 42 });

    const result = await cached(cache, "key", 60, fetcher);

    expect(result).toEqual({ value: 42 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("returns the cached value without calling the fetcher again", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn().mockResolvedValue({ value: 42 });

    await cached(cache, "key", 60, fetcher);
    const second = await cached(cache, "key", 60, fetcher);

    expect(second).toEqual({ value: 42 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("refetches when the cache entry is corrupt", async () => {
    const cache = memoryCache();
    await cache.put("key", "{not json");
    const fetcher = vi.fn().mockResolvedValue({ value: 7 });

    const result = await cached(cache, "key", 60, fetcher);

    expect(result).toEqual({ value: 7 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
