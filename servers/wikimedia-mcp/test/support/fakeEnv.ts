import { vi, type Mock } from "vitest";

/**
 * In-memory fake satisfying CacheNamespace.
 *
 * Unlike the plain `Map` used by this repo's other servers, this one **enforces Workers KV's
 * 512-byte key limit**, because a real KV `get()`/`put()` throws on an over-long key rather than
 * merely missing the cache. A permissive fake hid exactly that bug here once: a documented
 * 50-title `get_page_metadata` call built a key of over 600 bytes and would have failed in
 * production while every test passed.
 */
export function createFakeCache() {
  const store = new Map<string, string>();
  const assertKey = (key: string) => {
    const bytes = new TextEncoder().encode(key).length;
    if (bytes > 512) throw new Error(`KV key too long: ${bytes} bytes (max 512)`);
  };
  return {
    async get(key: string) {
      assertKey(key);
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      assertKey(key);
      store.set(key, value);
    },
  };
}

/**
 * In-memory fake satisfying @iolab/credentials' D1LikeDatabase.
 *
 * Empty by default, which is the case every tool must work in: the Wikimedia OAuth token is
 * optional and nothing here requires it.
 */
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

/** Builds a fake Env for wikimedia-mcp tool tests — no upstream credential configured. */
export function fakeEnv(): Env {
  return {
    MCP_CACHE: createFakeCache(),
    CREDENTIALS_DB: createFakeCredentialsDb(),
    ENCRYPTION_KEY: "NOnV4EUJ4r07rvPzrNy6SGdvJPCoAJQL+j7i2004jpo=",
  } as unknown as Env;
}

/** Build a JSON Response the way the Action API actually returns one. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export type FetchRoute = { match: (url: string) => boolean; body?: unknown; text?: string; status?: number };

/**
 * Stub global fetch with a URL-routed handler.
 *
 * `mockImplementation` rather than `mockResolvedValue` throughout, because a `Response` body can
 * only be read once — any handler making more than one upstream call would see an empty body on
 * the second read if a single Response instance were reused.
 */
export function stubFetchRoutes(routes: FetchRoute[]): Mock {
  const mock = vi.fn().mockImplementation((input: Request | string | URL) => {
    const url = requestUrl(input);
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) throw new Error(`No stubbed route matched ${url}`);
    if (route.text !== undefined) {
      return Promise.resolve(new Response(route.text, { status: route.status ?? 200 }));
    }
    return Promise.resolve(jsonResponse(route.body, route.status ?? 200));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function requestUrl(input: Request | string | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

type MockLike = { mock: { calls: unknown[][] } };

/** The URLs a stubbed fetch was called with, parsed. */
export function calledUrls(mock: MockLike): URL[] {
  return mock.mock.calls.map((call) => new URL(requestUrl(call[0] as Request | string | URL)));
}

/** The headers a stubbed fetch was called with on a given call index. */
export function calledHeaders(mock: MockLike, index = 0): Headers {
  const init = mock.mock.calls[index]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}
