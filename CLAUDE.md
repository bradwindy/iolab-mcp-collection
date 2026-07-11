# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

pnpm workspace monorepo (`packages/*`, `apps/*`, `servers/*`). Root scripts run across every package:

- `pnpm install`
- `pnpm run lint` — eslint across the repo
- `pnpm run typecheck` — per package: `wrangler types && tsc --noEmit`. `wrangler types` regenerates
  the gitignored `worker-configuration.d.ts` from that package's `wrangler.jsonc`; a stale copy is a
  common source of false type errors, so re-run it after touching a `wrangler.jsonc`.
- `pnpm run test` — per package: `vitest run`, against a real `workerd` runtime via
  `@cloudflare/vitest-pool-workers`, not mocks.
- `pnpm run build`
- `pnpm run deploy:all` — deploys every server and the portal (each package also has its own `deploy`
  script: `wrangler deploy`).

Work on one package with `pnpm --filter @nz-mcp/<name> <script>` (package names: `nz-govt-mcp`,
`nz-culture-mcp`, `nz-stats-mcp`, `nz-geo-mcp`, `nz-environment-mcp`, `nz-transport-mcp`,
`nz-markets-mcp`, `portal`, `credentials`, `mcp-kit`), or `cd` into `servers/<name>`, `apps/portal`, or
`packages/<name>` and run directly.

Run one test file: `cd servers/<name> && pnpm exec vitest run test/<file>.test.ts`. Filter by test name
with `-t "<name>"`.

## Architecture

Seven independent MCP servers (`servers/*`) plus one credential-management portal (`apps/portal`), each
its own Cloudflare Worker, sharing two packages:

- **`packages/mcp-kit`** — pagination, response formatting, TTL caching, rate-limit backoff, actionable
  tool errors (`toolError`/`upstreamError`/`missingCredentialError`), attribution helpers, and the
  bearer/OAuth auth every server uses identically (`requireBearerToken`, `buildOAuthMcpWorker` — see
  `src/oauth.ts`). Read the source before adding a tool — it's short, and duplicating any of it in a
  server is a signal something's wrong.
- **`packages/credentials`** — one D1-backed, AES-256-GCM-encrypted credential store. The portal writes
  to it; every server reads and decrypts at request time. Neither the repo nor any agent that helped
  build it ever sees a real upstream key.

Each server is a Durable-Object-backed `McpAgent` (Cloudflare Agents SDK) served over Streamable HTTP at
`/mcp`, wrapped by `buildOAuthMcpWorker` (`packages/mcp-kit/src/oauth.ts`) in `src/index.ts` instead of a
plain `fetch` handler. `/mcp` accepts either the shared `MCP_SHARED_TOKEN` bearer (checked first, as a
bypass — this is what Claude Code uses, since it connects server-to-server and can't complete an
interactive login) or an OAuth access token issued by that server's own `@cloudflare/workers-oauth-provider`
instance (what claude.ai's custom-connector flow uses). The OAuth provider's `/authorize` endpoint is the
one path actually gated by Cloudflare Access — everything else (`/mcp`, `/token`, `/register`, the
`.well-known` discovery documents) stays public for machine-to-machine calls; see `docs/SETUP.md` §8.
Tool handlers have the signature `(rawInput: unknown, env: Env) => Promise<ToolTextResult>`, registered
onto the agent's `McpServer` in `src/agent.ts`, whose `McpAgent` subclass takes the shared `OAuthProps`
(`{ email: string }`) as its Props generic — populated only for OAuth-authenticated requests, empty for
the bearer bypass.

Each server needs two `Env` types augmented, not one: `wrangler types` generates a global `Env`
interface (used by every tool handler and `fetch(request, env: Env, ctx)`) *and* a separate
`Cloudflare.Env` (used only where a test imports `env` from `"cloudflare:workers"` directly). The two
don't merge. Secrets aren't declared in `wrangler.jsonc`, so they're hand-typed in each server's
`src/env.d.ts` — augment both interfaces there if any test in that package uses the `cloudflare:workers`
import (currently only `nz-stats-mcp` does; the others only use it for `exports`, not `env`, in their
bearer-auth test). `OAUTH_PROVIDER`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `ACCESS_EMAIL` follow the
same hand-typed-secret pattern as `MCP_SHARED_TOKEN`; `OAUTH_KV` is a real binding (in `wrangler.jsonc`),
so `wrangler types` provides it on its own.

Domain and operator identity are treated as secrets and never committed: `wrangler.jsonc` route patterns
use a `yourdomain.com` placeholder (see `docs/SETUP.md`), and the real values — `PORTAL_URL` (every
server), `BASE_DOMAIN` and `ACCESS_EMAIL` (portal only) — are read from `env` at request time, set via
`wrangler secret put`.

New-server conventions (naming, tool design, upstream-client patterns) are documented in
`docs/ADDING_A_SERVER.md` and `docs/nz-research-mcp-best-practices.md` — read those before adding a
server or tool rather than inferring conventions from a single example.
