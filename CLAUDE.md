# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

pnpm workspace monorepo (`packages/*`, `apps/*`, `servers/*`). Root scripts run across every package:

- `pnpm install`
- `pnpm run lint` — eslint across the repo
- `pnpm run typecheck` — per package: `tsc --noEmit`, except `apps/gateway` which runs
  `wrangler types && tsc --noEmit` first. Only `apps/gateway` has a `wrangler.jsonc` — every other
  package (`servers/*`, `apps/portal`) gets its Workers-runtime global types (`Request`, `Response`,
  `crypto`, `console`, etc.) from `"lib": ["es2022", "dom"]` in its own `tsconfig.json`, and hand-types
  only the specific `Env` fields its own code touches (see Architecture, below) — never Workers
  binding types like `KVNamespace`/`D1Database` directly. Re-run `wrangler types` in `apps/gateway`
  after touching its `wrangler.jsonc`; a stale `worker-configuration.d.ts` is a common source of
  false type errors there.
- `pnpm run test` — per package: `vitest run`. Every package except `apps/portal` runs against a real
  `workerd` runtime via `@cloudflare/vitest-pool-workers`, not mocks — including `servers/*`, whose
  `vitest.config.ts` points `wrangler.configPath` at `../../apps/gateway/wrangler.jsonc` (they have no
  wrangler config of their own; see Architecture). `apps/portal`'s tests run under plain Node vitest
  instead, since its Hono app can be exercised directly via `.request()` with no Workers runtime
  needed — and because `@iolab/mcp-kit`'s main barrel pulls in `@cloudflare/workers-oauth-provider`,
  whose dist bundle imports `cloudflare:workers` at module scope and breaks under plain Node; the
  portal imports the Access-JWT check it needs via the dedicated `@iolab/mcp-kit/access` subpath
  instead (see `packages/mcp-kit/src/access.ts`'s top comment for the full story).
- `pnpm run build`
- `pnpm run deploy:all` / `cd apps/gateway && pnpm run deploy` — deploys the one gateway Worker. No
  other package has its own `deploy` script anymore.

Work on one package with `pnpm --filter @iolab/<name> <script>` (package names: `nz-govt-mcp`,
`nz-culture-mcp`, `nz-stats-mcp`, `nz-geo-mcp`, `nz-environment-mcp`, `nz-transport-mcp`,
`nz-markets-mcp`, `ia-mcp`, `wikimedia-mcp`, `reddit-mcp`, `gateway`, `portal`, `credentials`,
`mcp-kit`), or `cd`
into `servers/<name>`, `apps/gateway`, `apps/portal`, or `packages/<name>` and run directly.

Run one test file: `cd servers/<name> && pnpm exec vitest run test/<file>.test.ts`. Filter by test name
with `-t "<name>"`. OAuth/bearer-auth/path-routing tests live once, consolidated, in
`apps/gateway/test/` — not per-server anymore.

## Architecture

**One Cloudflare Worker** (`apps/gateway`) on **one hostname**, path-routing to every registered MCP
server plus the credential-management portal, sharing three packages:

- **`packages/mcp-kit`** — pagination, response formatting, TTL caching, rate-limit backoff, actionable
  tool errors (`toolError`/`upstreamError`/`missingCredentialError`), attribution helpers, and the
  bearer/OAuth auth every server uses identically (`requireBearerToken`, `buildMultiServerOAuthWorker`
  — see `src/oauth.ts`). `src/access.ts` is a separate module, deliberately free of any
  `@cloudflare/workers-oauth-provider` import (see Commands, above) — `verifyAccessJwt` lives there,
  importable via the `@iolab/mcp-kit/access` subpath by anything that can't tolerate the
  `cloudflare:workers` dependency oauth.ts pulls in. Read the source before adding a tool — it's
  short, and duplicating any of it in a server is a signal something's wrong.
- **`packages/credentials`** — one D1-backed, AES-256-GCM-encrypted credential store. The portal writes
  to it; every server reads and decrypts at request time. Neither the repo nor any agent that helped
  build it ever sees a real upstream key.
- **`apps/portal`** — the credential-management dashboard, Connect page, and per-server credential
  forms. **Not its own deployable Worker anymore** — it's a library (`"exports": { ".": "./src/app.ts"
  }`) that `apps/gateway` mounts as the OAuth provider's `defaultHandler`, under `/admin/*`. It
  authorizes its own routes in code (`verifyAccessJwt` from `@iolab/mcp-kit/access`, checked as Hono
  middleware on `/admin/*`) rather than relying on Cloudflare Access to cover the whole hostname — see
  the note on Access scoping below. `/` (outside `/admin`) is a separate, minimal, public landing page
  with no server list, no credential status, and no secrets.

Each server (`servers/*`) is a Durable-Object-backed `McpAgent` (Cloudflare Agents SDK), but is **not**
its own Worker — it's a package exporting only an `McpAgent` subclass (`"exports": { ".":
"./src/agent.ts" }`), registered into the gateway's server list (`apps/gateway/src/servers.ts`) and
served over Streamable HTTP at `/{slug}/mcp` (e.g. `/nz-govt/mcp`) by
`buildMultiServerOAuthWorker` — one shared `OAuthProvider` instance for every registered server, not
one per server. `/{slug}/mcp` accepts either the shared `MCP_SHARED_TOKEN` bearer (checked first, as a
per-path bypass — this is what Claude Code uses, since it connects server-to-server and can't complete
an interactive login) or an OAuth access token from the one shared authorization server (what
claude.ai's custom-connector flow uses, now working identically for every registered server with no
per-server opt-in). The OAuth provider's `/authorize` endpoint is the **one** path actually gated by
Cloudflare Access for the whole gateway; everything else (`/{slug}/mcp`, `/token`, `/register`, the
`.well-known` discovery documents, and — see above — `/admin/*` in application code instead) stays
public for machine-to-machine calls; see `docs/SETUP.md`.

**Collapsing to one authorization server removed the per-server OAuth-token isolation the old layout
had "for free."** `/authorize` mitigates this by requiring an RFC 8707 `resource` parameter naming
exactly one registered server's `/{slug}/mcp` path (`validateResourceForRegisteredPath` in
`packages/mcp-kit/src/oauth.ts`) — missing, multiple, cross-origin, origin-only, or
unregistered-path `resource` values are all rejected before a grant is created. This is deliberately
on by default; `DISABLE_RESOURCE_ENFORCEMENT=true` is a documented cutover escape hatch, not something
to reach for casually. `completeAuthorization` also always passes `revokeExistingGrants: false` — the
library's default (revoke every prior grant for the same user+client on a new grant) would otherwise
let authorizing connector B silently kill connector A's already-working token, since every registered
server now shares one `userId` (the operator email) and possibly one DCR `client_id` across
connectors. Both of these are regression-tested in `apps/gateway/test/multi-server-security.test.ts` —
don't "clean up" either without reading why they're there.

Tool handlers have the signature `(rawInput: unknown, env: Env) => Promise<ToolTextResult>`, registered
onto the agent's `McpServer` in `src/agent.ts`, whose `McpAgent` subclass takes the shared `OAuthProps`
(`{ email: string }`) as its Props generic — populated only for OAuth-authenticated requests, empty for
the bearer bypass.

Each `servers/*` package's own `src/env.d.ts` hand-types only the `Env` fields its own tool/client code
touches directly — `MCP_CACHE: CacheNamespace` (from `@iolab/mcp-kit`) and `CREDENTIALS_DB:
D1LikeDatabase` (from `@iolab/credentials`) if it caches or needs upstream credentials,
`ENCRYPTION_KEY`/`PORTAL_URL` if it needs credentials. `MCP_SHARED_TOKEN`, `OAUTH_PROVIDER`, and every
`ACCESS_*` field are the gateway's concern exclusively now — a server package never references them,
and its `env.d.ts` never declares them. `apps/gateway/src/env.d.ts` is the one place all of the
above, plus those gateway-only fields, are declared together (this is now the **only** hand-typed-Env
file that matters for secrets — every other package hand-types a strict subset).

Domain and operator identity are treated as secrets and never committed: `apps/gateway/wrangler.jsonc`'s
route pattern uses a `yourdomain.com` placeholder (see `docs/SETUP.md`), and the real values —
`PORTAL_URL`, `BASE_DOMAIN`, `ACCESS_EMAIL` — are read from `env` at request time, set via
`wrangler secret put`, once for the whole gateway.

New-server conventions (naming, tool design, upstream-client patterns) are documented in
`docs/ADDING_A_SERVER.md` and `docs/research-mcp-best-practices.md` — read those before adding a
server or tool rather than inferring conventions from a single example.
