# Adding a new server

This collection's servers all follow one convention set, established by `servers/nz-govt-mcp` (the
first one built, and still the simplest reference — it needs no upstream credentials at all). Read that
server in full before starting; this doc is the checklist, not a tutorial.

A server here is a `servers/{name}/` package containing only an `McpAgent` class (`src/agent.ts`),
its tools, and its clients — it is **not** its own deployable Worker. Every server is registered
into the one gateway Worker (`apps/gateway`), which owns the `wrangler.jsonc`, the OAuth machinery,
and the path it's served at (`/{slug}/mcp`). See §6.

## 1. Scope it

Read [`docs/research-mcp-best-practices.md`](research-mcp-best-practices.md) §1 first. A new
server needs:

- A one-sentence purpose ("civic and open-data research," not "misc APIs").
- A name an LLM could guess from context alone: `nz-{domain}-mcp`.
- 5-15 tools once built. Fewer than 5 probably belongs merged into an existing server; more than 15,
  consider splitting.

## 2. Research the upstream APIs before writing any types

For every API the new server wraps:

- Read its entry in [api-catalog](https://github.com/bradwindy/api-catalog)'s `src/data/apis.ts` for
  the base URL, auth model, sample request, and reference doc links — but **verify them live**. Several
  servers in this collection found the catalog's documented endpoint was wrong or incomplete once
  actually queried (e.g. Te Papa's real search endpoint differs from its documented one; LINZ Data
  Service turned out to be a point+radius query API, not the assumed bbox/filter shape).
- For any endpoint requiring no key, `curl` it live and read the real response shape — don't guess field
  names from docs alone.
- For endpoints requiring a key you don't have: you may **never** obtain or use a real key yourself
  (no signups, no keys found via search engines, nothing). Design defensively against documented
  request/response shapes, note what's unconfirmed in the server's README, and let the operator verify
  once they've entered a real key via the portal.

## 3. Scaffold the directory

```
servers/nz-{domain}-mcp/
├── package.json          # copy from an existing server, rename, adjust deps if needed; "exports":
│                          # { ".": "./src/agent.ts" } is what lets the gateway import the agent class
├── tsconfig.json          # "lib": ["es2022", "dom"] for Request/Response/crypto/console/etc — this
│                          # package has no wrangler.jsonc of its own, so no local `wrangler types`
├── vitest.config.ts        # points wrangler.configPath at ../../apps/gateway/wrangler.jsonc — tests
│                          # run against the gateway's shared config, not a config of their own
├── README.md
├── src/
│   ├── env.d.ts          # hand-written Env augmentation for ONLY the fields this server's own code
│   │                     # touches directly: MCP_CACHE (CacheNamespace, from @iolab/mcp-kit),
│   │                     # CREDENTIALS_DB (D1LikeDatabase, from @iolab/credentials), ENCRYPTION_KEY,
│   │                     # PORTAL_URL — as needed. MCP_SHARED_TOKEN/OAUTH_PROVIDER/ACCESS_* are the
│   │                     # gateway's concern now, never this package's.
│   ├── constants.ts       # SERVER_SLUG (must equal the credentials-table `server` column value used
│   │                     # in apps/portal/src/manifest.ts — not the gateway's URL slug, see §7), and
│   │                     # credential key name(s)
│   ├── agent.ts           # McpAgent<Env, State, OAuthProps> subclass; one this.server.registerTool(...) per tool
│   ├── clients/           # one file per upstream API — throw UpstreamHttpError on !response.ok
│   └── tools/             # one file per tool: {name}InputShape, {name}OutputShape, and
│   │                       # handler: (rawInput: unknown, env: Env) => Promise<ToolTextResult>
└── test/
    └── {tool}.test.ts       # one per tool, mocking global.fetch — bearer-auth and OAuth flow tests
                              # now live once, consolidated, in apps/gateway/test/
```

## 4. Use the shared packages — don't reinvent them

- **`@iolab/mcp-kit`** (`packages/mcp-kit/src/*.ts` — read the source, it's short): `paginate`,
  `describePage`, `limitParam`/`offsetParam`/`responseFormatParam`, `jsonResult`, `selectFormat`,
  `truncationNotice`, `toolError`, `upstreamError`, `missingCredentialError`, `UpstreamHttpError`,
  `attribution`, `READ_ONLY_OPEN_WORLD_ANNOTATIONS`, `cached`, `CACHE_TTL`, `fetchWithBackoff`,
  `CacheNamespace` (the minimal structural type `env.MCP_CACHE` is hand-typed as — §3, above), and
  `OAuthProps` (the `Props` generic your `agent.ts`'s `McpAgent<Env, State, OAuthProps>` uses). A
  server package never calls `buildMultiServerOAuthWorker` itself — that's the gateway's job (§6).
- **`@iolab/credentials`** (only if your server needs upstream API keys):
  `getCredential(env.CREDENTIALS_DB, SERVER_SLUG, keyName, env.ENCRYPTION_KEY)`,
  `missingCredentialError(SERVER_SLUG, keyName, PORTAL_URL)` when it's unset.

## 5. Tool design checklist (per best-practices doc §2-4)

- [ ] `nz_{domain}_verb_noun` naming, `snake_case`.
- [ ] Search-shaped, not 1:1 endpoint wraps — consolidate list+get where the list only ever feeds the get.
- [ ] Every list-shaped tool: `limit`/`offset` in, `total_count`/`has_more`/`next_offset` out.
- [ ] Any upstream call that paginates server-side (SQL, Elasticsearch, ArcGIS, OData, etc.) passes an
  explicit, deterministic sort/orderBy — see best-practices doc §4 "Pagination must be stable". Without
  one, `LIMIT`/`OFFSET`-style pagination is not guaranteed stable and can silently duplicate or drop rows
  across pages (confirmed live against CKAN's `datastore_search`, see `nz-govt-mcp`'s `datagovt.ts`).
- [ ] A field with a small, confirmed, fixed set of values (verified against the live upstream, not
  guessed) gets a `z.enum([...])` filter using the upstream's native exact-match/filter mechanism, not
  folded into a free-text search param — see best-practices doc §4 "Structured filters over free text".
- [ ] `response_format: "concise" | "detailed"` — only include it if the two modes are genuinely
  different; don't add it as a no-op.
- [ ] Geospatial tools: never return raw geometry by default — centroid/bbox summaries only.
- [ ] `outputSchema` declared and structurally matching what the handler actually returns — including
  every optional field the handler sometimes populates (a common gap: `attribution` schemas that forget
  an optional `license` field the handler sometimes sets).
- [ ] `annotations: { ...READ_ONLY_OPEN_WORLD_ANNOTATIONS, title: "..." }` on every tool.
- [ ] `attribution` with `source` (and `license`/`url` where sensible) on every response.
- [ ] Truncation notices via `truncationNotice()` whenever a result set is capped.
- [ ] **Never return a decrypted upstream credential value to the caller**, in any field, at any
  `response_format`. If a tool's core purpose requires a URL with a key embedded (e.g. a map-tile URL a
  browser needs to fetch directly), mask it behind an explicit opt-in parameter defaulting to `false`
  (see `nz-geo-mcp`'s `getBasemapStyleUrl` / `reveal_key` for the pattern) rather than exposing it by
  default.
- [ ] Any raw-query escape hatch (SQL, etc.) validates its guard can't be bypassed by statement-chaining
  or similar — anchor-at-start regexes alone are not enough.
- [ ] Near-real-time feeds (vehicle positions, quakes, traffic) are wrapped in `cached(env.MCP_CACHE, key,
  CACHE_TTL.NEAR_REALTIME, fetcher)` — especially anything backed by a tightly rate-limited upstream.

## 6. Register in the gateway

Servers are no longer independently deployed Workers — registering a new one is a code change to
`apps/gateway`, not a new `wrangler.jsonc`.

1. Add the workspace dependency: `apps/gateway/package.json` → `"@iolab/nz-{domain}-mcp": "workspace:*"`.
2. `apps/gateway/src/servers.ts`: import the agent class and add one entry to the `SERVERS` array —
   `{ slug: "nz-{domain}", agent: Nz{Domain}Mcp, binding: "NZ_{DOMAIN}_MCP" }`. `slug` is the URL path
   segment (`/nz-{domain}/mcp`) — it does **not** have to match the server directory name or the
   credentials-table `SERVER_SLUG` constant (§7 covers that one), though keeping them aligned is
   simpler to reason about.
3. `apps/gateway/src/index.ts`: re-export the new agent class (`export { Nz{Domain}Mcp } from
   "./servers.js";`) — `wrangler.jsonc`'s `durable_objects.bindings[].class_name` must resolve
   against a top-level export of the Worker's `main` module.
4. `apps/gateway/wrangler.jsonc`: add the Durable Object binding and its `new_sqlite_classes` entry:
   ```jsonc
   "durable_objects": { "bindings": [
     // ...existing entries...
     { "name": "NZ_{DOMAIN}_MCP", "class_name": "Nz{Domain}Mcp" }
   ]},
   "migrations": [{ "tag": "v1", "new_sqlite_classes": [/* ...existing..., */ "Nz{Domain}Mcp"] }],
   ```
   A **new** Durable Object class added to an *existing* `migrations` tag (rather than the original
   `v1` list) needs its own `new_sqlite_classes` migration entry with a new `tag` — see the
   [Durable Objects migrations docs](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
   if the gateway has already been deployed once with the original server set.
5. Regenerate types and verify: `cd apps/gateway && pnpm exec wrangler types && pnpm exec tsc --noEmit`.

Do **not** install `@cloudflare/workers-types` in the server package itself — it needs no Workers
binding types of its own beyond the minimal structural interfaces named in §3 (`CacheNamespace`,
`D1LikeDatabase`), plus DOM lib types (`Request`/`Response`/`crypto`/`console`/etc., via
`"lib": ["es2022", "dom"]` in `tsconfig.json`) for the ordinary web-platform APIs its code uses. The
real Workers binding types (`KVNamespace`, `D1Database`, `DurableObjectNamespace`) are only needed by
the gateway itself, which still gets them from `wrangler types`.

The new server works with Claude Code's static bearer token as soon as it's registered and deployed —
no per-server OAuth setup needed anymore. claude.ai's OAuth flow works identically for every
registered server too, since the gateway's one shared authorization server covers all of them; there
is no more per-server "enable OAuth" step (see [docs/SETUP.md](SETUP.md)).

## 7. If the portal needs to know about your new credentials

Add an entry to `apps/portal/src/manifest.ts`'s `SERVERS` array:
- `slug`: the stable identifier — the `server` column in the shared credentials table. Match your
  `SERVER_SLUG` constant (§3, `src/constants.ts`) exactly.
- `pathPrefix`: must exactly match the `slug` you registered in `apps/gateway/src/servers.ts` (§6) —
  this is what builds the live `https://mcp.{BASE_DOMAIN}/{pathPrefix}/mcp` URL shown on the
  dashboard and Connect page. A mismatch here means the portal renders a URL the gateway doesn't
  actually serve.
- every credential `envName` must exactly match the constant your server actually reads via
  `getCredential(...)`.

A slug or key-name mismatch here means the portal can write a credential row your server can never
read back — this has happened once already in this repo (caught by review, not by any test), so
double-check it by hand.

## 8. Test, deploy, verify

```bash
cd servers/nz-{domain}-mcp
pnpm exec tsc --noEmit
pnpm exec eslint .          # from repo root: pnpm exec eslint servers/nz-{domain}-mcp
pnpm exec vitest run        # runs against apps/gateway's shared wrangler config — see §3

cd ../../apps/gateway
pnpm exec wrangler types
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec wrangler deploy
```

Then live-smoke-test against the deployed gateway: no-auth → 401, wrong token → 401, correct token +
`initialize` → `mcp-session-id` header + `serverInfo`, `notifications/initialized` → 202,
`tools/list` on `/nz-{domain}/mcp` → your tool names (and no other server's), `tools/call` on at
least one no-credential tool → real upstream data, and one credential-gated tool (if any) → the
`missingCredentialError` message.

## 9. Write the README

Every server's README documents: what it wraps and why, a tools table (name, description, upstream API,
whether it needs a key), a numbered "Upstream API keys" section per credential with signup steps (pull
these from `docs/API_KEYS.md`, keep both in sync), 2-3 example research questions, and a "Research
notes" section for anything you discovered live that the official docs got wrong or didn't cover —
future you (or the next contributor) will thank you.
