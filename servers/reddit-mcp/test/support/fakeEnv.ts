import { vi, type Mock } from "vitest";
import { encryptValue } from "@iolab/credentials";
import { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME } from "../../src/constants.js";
import type { CommentThing, PostData, SubredditData } from "../../src/types.js";

/**
 * In-memory fake satisfying CacheNamespace.
 *
 * Enforces Workers KV's 512-byte key limit, because a real KV `get()`/`put()` throws on an
 * over-long key rather than merely missing the cache — and this server builds keys from
 * caller-supplied search queries and comment-id lists, both unbounded. A permissive fake would let
 * that ship. Also records `put` options so TTL selection is assertable.
 */
export function createFakeCache() {
  const store = new Map<string, string>();
  const puts: Array<{ key: string; ttl: number | undefined }> = [];
  const assertKey = (key: string) => {
    const bytes = new TextEncoder().encode(key).length;
    if (bytes > 512) throw new Error(`KV key too long: ${bytes} bytes (max 512)`);
  };
  return {
    puts,
    store,
    async get(key: string) {
      assertKey(key);
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      assertKey(key);
      store.set(key, value);
      puts.push({ key, ttl: opts?.expirationTtl });
    },
  };
}

export const TEST_ENCRYPTION_KEY = "NOnV4EUJ4r07rvPzrNy6SGdvJPCoAJQL+j7i2004jpo=";

/**
 * In-memory fake satisfying @iolab/credentials' D1LikeDatabase, seeded per credential key.
 *
 * Unlike wikimedia-mcp's, this one has to distinguish *which* key is being read: reddit-mcp
 * requires three, and the missing-credential tests assert that the error names the right one.
 */
export function createFakeCredentialsDb(values: Map<string, string>) {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          bound = args;
          return statement;
        },
        async run() {
          return {};
        },
        async first() {
          // The store's SELECT binds (server, key_name) in that order.
          const keyName = String(bound[1] ?? "");
          const value = values.get(keyName);
          return value === undefined ? null : { value };
        },
        async all() {
          return { results: [] };
        },
      };
      void query;
      return statement;
    },
  };
}

/** A credentials store whose every read rejects — a D1 outage or a corrupted row. */
export function createFailingCredentialsDb() {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async run(): Promise<never> {
          throw new Error("D1 unavailable");
        },
        async first(): Promise<never> {
          throw new Error("D1 unavailable");
        },
        async all(): Promise<never> {
          throw new Error("D1 unavailable");
        },
      };
    },
  };
}

export type FakeEnvOptions = {
  /** Pass null to leave that credential unset and exercise the missing-credential path. */
  clientId?: string | null;
  clientSecret?: string | null;
  username?: string | null;
  failingCredentials?: boolean;
};

/**
 * Build a fake Env with credentials seeded by default.
 *
 * Seeded is the right default here — unlike wikimedia-mcp, where the no-credential case is what
 * every tool must work in, reddit-mcp has no anonymous path at all, so a credentialled env is the
 * normal case and the unset case is the exception worth naming explicitly.
 */
export async function fakeEnv(opts: FakeEnvOptions = {}): Promise<Env & { MCP_CACHE: ReturnType<typeof createFakeCache> }> {
  const entries = new Map<string, string>();
  const seed = async (keyName: string, value: string | null | undefined, fallback: string) => {
    const resolved = value === undefined ? fallback : value;
    if (resolved === null) return;
    entries.set(keyName, await encryptValue(resolved, TEST_ENCRYPTION_KEY));
  };
  await seed(REDDIT_CLIENT_ID, opts.clientId, "test-client-id");
  await seed(REDDIT_CLIENT_SECRET, opts.clientSecret, "test-client-secret");
  await seed(REDDIT_USERNAME, opts.username, "testuser");

  const cache = createFakeCache();
  return {
    MCP_CACHE: cache,
    CREDENTIALS_DB: opts.failingCredentials ? createFailingCredentialsDb() : createFakeCredentialsDb(entries),
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    PORTAL_URL: "https://portal.example",
  } as unknown as Env & { MCP_CACHE: ReturnType<typeof createFakeCache> };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export type FetchRoute = {
  match: (url: string) => boolean;
  body?: unknown;
  text?: string;
  status?: number;
  headers?: Record<string, string>;
  /** Bodies consumed in order across successive matches, for retry and re-mint tests. */
  sequence?: Array<{ body?: unknown; status?: number; headers?: Record<string, string> }>;
};

export const isTokenRequest = (url: string) => url.includes("/api/v1/access_token");
export const isOauthHost = (url: string) => url.startsWith("https://oauth.reddit.com");

/** The standard successful token mint. */
export function tokenRoute(overrides: { status?: number; expiresIn?: number; token?: string } = {}): FetchRoute {
  return {
    match: isTokenRequest,
    status: overrides.status ?? 200,
    body: { access_token: overrides.token ?? "test-token", token_type: "bearer", expires_in: overrides.expiresIn ?? 3600 },
  };
}

/**
 * Stub global fetch with a URL-routed handler.
 *
 * `mockImplementation` rather than `mockResolvedValue` throughout, because a `Response` body can
 * only be read once — any handler making more than one upstream call would see an empty body on
 * the second read if a single Response instance were reused.
 */
export function stubFetchRoutes(routes: FetchRoute[]): Mock {
  const cursors = new Map<FetchRoute, number>();
  const mock = vi.fn().mockImplementation((input: Request | string | URL) => {
    const url = requestUrl(input);
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) throw new Error(`No stubbed route matched ${url}`);

    if (route.sequence) {
      const index = cursors.get(route) ?? 0;
      cursors.set(route, index + 1);
      const step = route.sequence[Math.min(index, route.sequence.length - 1)];
      return Promise.resolve(jsonResponse(step?.body ?? {}, step?.status ?? 200, step?.headers ?? {}));
    }
    if (route.text !== undefined) {
      return Promise.resolve(new Response(route.text, { status: route.status ?? 200, headers: route.headers ?? {} }));
    }
    return Promise.resolve(jsonResponse(route.body, route.status ?? 200, route.headers ?? {}));
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

export function calledUrls(mock: MockLike): URL[] {
  return mock.mock.calls.map((call) => new URL(requestUrl(call[0] as Request | string | URL)));
}

export function dataUrls(mock: MockLike): URL[] {
  return calledUrls(mock).filter((url) => url.hostname === "oauth.reddit.com");
}

export function calledHeaders(mock: MockLike, index = 0): Headers {
  const init = mock.mock.calls[index]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

// --- Upstream fixture builders -------------------------------------------------------------

export function post(overrides: Partial<PostData> = {}): PostData {
  return {
    id: "1abc2de",
    name: "t3_1abc2de",
    title: "A post about kiwi",
    author: "quantcurious",
    subreddit: "newzealand",
    permalink: "/r/newzealand/comments/1abc2de/a_post_about_kiwi/",
    selftext: "Kiwi are flightless birds endemic to New Zealand.",
    is_self: true,
    score: 1247,
    upvote_ratio: 0.94,
    num_comments: 431,
    created_utc: 1_700_000_000,
    over_18: false,
    ...overrides,
  };
}

/** A `t1` thing with sensible defaults; `replies` defaults to Reddit's literal empty string. */
export function t1(overrides: Record<string, unknown> = {}): CommentThing {
  return {
    kind: "t1",
    data: {
      id: "c1",
      name: "t1_c1",
      author: "alice",
      body: "A comment.",
      score: 42,
      created_utc: 1_700_000_100,
      parent_id: "t3_1abc2de",
      link_id: "t3_1abc2de",
      replies: "",
      ...overrides,
    },
  } as CommentThing;
}

/** A `more` thing. Pass `{ id: "_", children: [] }` for a continue-this-thread marker. */
export function more(overrides: Record<string, unknown> = {}): CommentThing {
  return {
    kind: "more",
    data: {
      id: "m1",
      name: "t1_m1",
      parent_id: "t3_1abc2de",
      depth: 0,
      count: 12,
      children: ["x1", "x2"],
      ...overrides,
    },
  } as CommentThing;
}

/** The two-element array `GET /comments/{id}` returns. */
export function commentsResponse(postData: PostData, children: CommentThing[]): unknown {
  return [
    { kind: "Listing", data: { children: [{ kind: "t3", data: postData }], after: null, before: null } },
    { kind: "Listing", data: { children, after: null, before: null } },
  ];
}

export function listing(children: PostData[], after: string | null = null): unknown {
  return {
    kind: "Listing",
    data: { children: children.map((data) => ({ kind: "t3", data })), after, before: null },
  };
}

export function subreddit(overrides: Partial<SubredditData> = {}): SubredditData {
  return {
    display_name: "newzealand",
    display_name_prefixed: "r/newzealand",
    title: "New Zealand",
    public_description: "Kia ora and welcome.",
    subscribers: 500_000,
    active_user_count: 1_200,
    created_utc: 1_200_000_000,
    over18: false,
    subreddit_type: "public",
    url: "/r/newzealand/",
    ...overrides,
  };
}

export function subredditListing(subs: SubredditData[], after: string | null = null): unknown {
  return {
    kind: "Listing",
    data: { children: subs.map((data) => ({ kind: "t5", data })), after, before: null },
  };
}
