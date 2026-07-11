# Adding a new server

This collection's 7 servers all follow one convention set, established by `servers/nz-govt-mcp` (the
first one built, and still the simplest reference — it needs no upstream credentials at all). Read that
server in full before starting; this doc is the checklist, not a tutorial.

## 1. Scope it

Read [`docs/nz-research-mcp-best-practices.md`](nz-research-mcp-best-practices.md) §1 first. A new
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
├── package.json          # copy from an existing server, rename, adjust deps if needed
├── wrangler.jsonc
├── tsconfig.json
├── vitest.config.ts
├── .dev.vars.example
├── README.md
├── src/
│   ├── env.d.ts          # hand-written Env augmentation: MCP_SHARED_TOKEN, OAUTH_PROVIDER, ACCESS_TEAM_DOMAIN,
│   │                     # ACCESS_AUD, ACCESS_EMAIL, + ENCRYPTION_KEY if you need credentials
│   ├── constants.ts       # SERVER_SLUG (must equal wrangler.jsonc "name"), PORTAL_URL, credential key name(s)
│   ├── index.ts           # export default buildOAuthMcpWorker(YourAgent, "YOUR_DO_BINDING")
│   ├── agent.ts           # McpAgent<Env, State, OAuthProps> subclass; one this.server.registerTool(...) per tool
│   ├── clients/           # one file per upstream API — throw UpstreamHttpError on !response.ok
│   └── tools/             # one file per tool: {name}InputShape, {name}OutputShape, async handler(rawInput, env?)
└── test/
    ├── index.test.ts       # bearer-auth gate, via `import { exports } from "cloudflare:workers"`
    ├── oauth.test.ts        # OAuth flows — copy an existing server's, only the ORIGIN constant changes
    └── {tool}.test.ts       # one per tool, mocking global.fetch
```

## 4. Use the shared packages — don't reinvent them

- **`@nz-mcp/mcp-kit`** (`packages/mcp-kit/src/*.ts` — read the source, it's short): `paginate`,
  `describePage`, `limitParam`/`offsetParam`/`responseFormatParam`, `jsonResult`, `selectFormat`,
  `truncationNotice`, `toolError`, `upstreamError`, `missingCredentialError`, `UpstreamHttpError`,
  `attribution`, `READ_ONLY_OPEN_WORLD_ANNOTATIONS`, `cached`, `CACHE_TTL`, `fetchWithBackoff`,
  `requireBearerToken`, `buildOAuthMcpWorker`, `OAuthProps` — the standard `index.ts`/`agent.ts` shape
  (§6, below) uses the last two; see `packages/mcp-kit/src/oauth.ts` for how the OAuth wrapper works.
- **`@nz-mcp/credentials`** (only if your server needs upstream API keys):
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

## 6. Wire the Cloudflare config

`wrangler.jsonc`:
```jsonc
{
  "name": "nz-{domain}-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-08",   // match every other server's date exactly
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "NZ_{DOMAIN}_MCP", "class_name": "Nz{Domain}Mcp" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Nz{Domain}Mcp"] }],
  "kv_namespaces": [
    { "binding": "MCP_CACHE", "id": "<shared KV id>" },
    // Own namespace per server — create with `wrangler kv namespace create OAUTH_KV`, see docs/SETUP.md §8.1.
    { "binding": "OAUTH_KV", "id": "<this server's own OAuth KV id>" }
  ],
  // Only if the server needs upstream credentials:
  "d1_databases": [{ "binding": "CREDENTIALS_DB", "database_name": "nz-mcp-credentials", "database_id": "<shared D1 id>" }],
  "routes": [{ "pattern": "nz-{domain}.mcp.<your-domain>", "custom_domain": true }],
  "observability": { "enabled": true }
}
```

Do **not** install `@cloudflare/workers-types` — this repo relies entirely on `wrangler types`-generated
runtime types (`worker-configuration.d.ts`, gitignored, regenerate after any config change) plus a
hand-written `src/env.d.ts` for secrets not declared in `wrangler.jsonc`. `OAUTH_KV` is a binding, so
`wrangler types` provides it automatically once it's in `wrangler.jsonc`; you do still need
`@cloudflare/workers-oauth-provider` and `jose` as **devDependencies** (types only — the runtime code
lives in `@nz-mcp/mcp-kit`) so `src/env.d.ts` can name `OAuthHelpers`, and so `test/oauth.test.ts` can
sign test JWTs.

Every new server also needs a self-hosted Cloudflare Access application scoped to its `/authorize` path
and three secrets (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_EMAIL`) before OAuth actually works end to
end — see [docs/SETUP.md §8](SETUP.md#8-oauth-for-claudeai-optional) for the exact steps. The server
works with Claude Code's static bearer token immediately either way; OAuth is what claude.ai needs.

## 7. If the portal needs to know about your new credentials

Add an entry to `apps/portal/src/manifest.ts`'s `SERVERS` array — `slug` must exactly match your
`wrangler.jsonc "name"` **and** every credential `envName` must exactly match the constant your server
actually reads via `getCredential(...)`. A slug or key-name mismatch here means the portal can write a
credential row your server can never read back — this has happened once already in this repo (caught by
review, not by any test), so double-check it by hand.

## 8. Test, deploy, verify

```bash
cd servers/nz-{domain}-mcp
pnpm exec wrangler types
pnpm exec tsc --noEmit
pnpm exec eslint .          # from repo root: pnpm exec eslint servers/nz-{domain}-mcp
pnpm exec vitest run
pnpm exec wrangler deploy
printf '%s' "<MCP_SHARED_TOKEN>" | pnpm exec wrangler secret put MCP_SHARED_TOKEN
printf '%s' "<ENCRYPTION_KEY>"  | pnpm exec wrangler secret put ENCRYPTION_KEY   # only if you bound CREDENTIALS_DB
printf '%s' "<PORTAL_URL>"      | pnpm exec wrangler secret put PORTAL_URL
# Only if you're enabling OAuth for claude.ai on this server — see docs/SETUP.md §8:
printf '%s' "<ACCESS_TEAM_DOMAIN>" | pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN
printf '%s' "<ACCESS_AUD>"         | pnpm exec wrangler secret put ACCESS_AUD
printf '%s' "<ACCESS_EMAIL>"       | pnpm exec wrangler secret put ACCESS_EMAIL
```

Then live-smoke-test: no-auth → 401, wrong token → 401, correct token + `initialize` →
`mcp-session-id` header + `serverInfo`, `notifications/initialized` → 202, `tools/list` → your tool
names, `tools/call` on at least one no-credential tool → real upstream data, and one credential-gated
tool (if any) → the `missingCredentialError` message.

## 9. Write the README

Every server's README documents: what it wraps and why, a tools table (name, description, upstream API,
whether it needs a key), a numbered "Upstream API keys" section per credential with signup steps (pull
these from `docs/API_KEYS.md`, keep both in sync), 2-3 example research questions, and a "Research
notes" section for anything you discovered live that the official docs got wrong or didn't cover —
future you (or the next contributor) will thank you.
