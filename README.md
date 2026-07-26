# iolab-mcp-collection

A collection of remote [MCP](https://modelcontextprotocol.io) servers exposing free and self-service
New Zealand public APIs to Claude (or any MCP client), clustered by research domain, and served from
**one Cloudflare Worker** at one hostname.

Built from the API inventory in [api-catalog](https://github.com/bradwindy/api-catalog) (24 NZ public
APIs) following the clustering and tool-design guidance in
[`docs/research-mcp-best-practices.md`](docs/research-mcp-best-practices.md): cluster by research
domain rather than one-server-per-API or one-giant-server, design tools around research questions rather
than 1:1 endpoint wraps, paginate everything, and keep response payloads lean.

## The servers

| Server | Domain | Tools | Upstream APIs | URL |
|---|---|---|---|---|
| [`nz-govt-mcp`](servers/nz-govt-mcp) | Civic & open data | 7 | Charities Register, data.govt.nz, Auckland Council Open Data, Education Counts (Schools + ECE) | `/nz-govt/mcp` |
| [`nz-culture-mcp`](servers/nz-culture-mcp) | Digital heritage & museums | 4 | DigitalNZ, Te Papa Collections | `/nz-culture/mcp` |
| [`nz-stats-mcp`](servers/nz-stats-mcp) | Official statistics | 4 | Stats NZ Aotearoa Data Explorer (SDMX) | `/nz-stats/mcp` |
| [`nz-geo-mcp`](servers/nz-geo-mcp) | Geospatial & property | 6 | LINZ Data Service, LINZ Basemaps, Canterbury Maps | `/nz-geo/mcp` |
| [`nz-environment-mcp`](servers/nz-environment-mcp) | Hazards, weather & climate | 9 | GeoNet, GeoNet FDSN, NIWA Tides/UV/CO2 | `/nz-environment/mcp` |
| [`nz-transport-mcp`](servers/nz-transport-mcp) | Traffic & transport | 10 | Auckland Transport, NZTA Traffic & Travel, NZTA TMS/MVR/Licence datasets | `/nz-transport/mcp` |
| [`nz-markets-mcp`](servers/nz-markets-mcp) | Lending rates & markets | 7 | Rates API, NZXplorer, Electricity Authority EMI | `/nz-markets/mcp` |

Every server:

- exposes tools designed around research questions, not raw endpoints (`nz_{domain}_verb_noun`, always
  paginated, always attributed to its upstream source and license)
- runs read-only, with `readOnlyHint`/`openWorldHint` annotations on every tool
- is an `McpAgent` (Cloudflare [Agents SDK](https://developers.cloudflare.com/agents/)) served over
  Streamable HTTP at its own path on the one gateway Worker (`/{slug}/mcp` — see the table above)
- gates its endpoint behind a single shared bearer token, and OAuth 2.1 for claude.ai (works
  identically for every server — see [Connecting](#connecting) below)
- reads any upstream API keys it needs from a shared, AES-256-GCM-encrypted D1 store — see
  [Architecture](#architecture)

Each server's own README documents its exact tools, required upstream credentials (if any), and example
research questions it can answer.

## Architecture

```
                    ┌───────────────────────────────────────────┐
                    │   Cloudflare Access — gates ONE path:      │
                    │   /authorize                               │
                    └───────────────────┬───────────────────────┘
                                        │
                            https://mcp.yourdomain.com
                    ┌───────────────────▼───────────────────────┐
                    │              apps/gateway                   │
                    │   ONE Worker · ONE OAuthProvider             │
                    │                                              │
                    │   /authorize /token /register /.well-known/* │
                    │   /{slug}/mcp  ×7  (bearer OR OAuth token,   │
                    │                     per-path audience check) │
                    │   /             public landing page          │
                    │   /admin/*      portal — Access checked in   │
                    │                 code (verifyAccessJwt)       │
                    └───────────────────┬───────────────────────┘
                                        │ writes (AES-256-GCM)
                                        ▼
                    ┌─────────────────────────────────────────┐
                    │     shared D1: nz-mcp-credentials         │
                    │     credentials(server, key_name, value)  │
                    └───────────────────┬───────────────────────┘
                                        │ reads + decrypts
        ┌───────────────┬───────────────┼───────────────┬───────────────┬──────────────┐
        ▼               ▼               ▼               ▼               ▼              ▼
  nz-govt-mcp    nz-culture-mcp   nz-stats-mcp     nz-geo-mcp    nz-environment  nz-transport
  nz-markets-mcp
   (7 servers, each an McpAgent Durable Object registered into the one gateway Worker)
        │               │               │               │               │              │
        ▼               ▼               ▼               ▼               ▼              ▼
   live NZ public / self-service APIs (Charities Register, GeoNet, LINZ, NIWA, Stats NZ, AT, NZTA, ...)
```

- **Gateway** (`apps/gateway`): the one deployed Worker. Owns the `wrangler.jsonc`, the one shared
  `@cloudflare/workers-oauth-provider` instance (`buildMultiServerOAuthWorker`,
  `packages/mcp-kit/src/oauth.ts`), and the Durable Object bindings for every registered server.
  Replaces what used to be eight independent Workers (one portal + seven servers), each with its own
  OAuth authorization server and `OAUTH_KV` namespace.
- **Portal** (`apps/portal`): mounted by the gateway under `/admin/*`, not its own deployable Worker.
  This is where you paste in your upstream API keys — they're encrypted with AES-256-GCM before being
  written to D1, and the portal never renders a previously-set value back into a form. Since the
  gateway's hostname must also serve `/token`/`/register`/`/.well-known/*` publicly for
  machine-to-machine OAuth calls, Cloudflare Access can no longer cover the whole hostname the way it
  covered the portal's own hostname before — `/admin/*` authorizes itself in application code instead
  (`verifyAccessJwt`), checked against the same Access session `/authorize` establishes. `/` (outside
  `/admin`) is a separate, minimal, public landing page with no operational detail.
- **Shared credential store** (`packages/credentials`): one D1 database, one `ENCRYPTION_KEY` Worker
  secret shared across the whole gateway. The portal writes; each server reads and decrypts at
  request time. Neither the repo nor any AI agent that helped build it ever saw a real upstream key —
  Cloudflare secrets are write-only by design.
- **MCP servers** (`servers/*`): each is a package exporting only an `McpAgent` subclass (no
  `wrangler.jsonc`, no independent deploy) served at its own path — `/{slug}/mcp` — on the gateway.
  That path accepts a shared bearer token (`MCP_SHARED_TOKEN`), checked in application code before
  the request reaches the MCP handler — this is what Claude Code uses, since it connects
  server-to-server and can't complete an interactive login. It also accepts an OAuth 2.1 + PKCE access
  token from the gateway's one shared authorization server, gated by Cloudflare Access on `/authorize`
  only — this is what claude.ai's custom-connector flow uses, and now works out of the box for every
  registered server with no per-server setup step. A token minted for one server's `resource` is
  rejected at every other server's path — see [docs/SETUP.md](docs/SETUP.md) for the full explanation
  of what one shared authorization server does and doesn't isolate.
- **Shared tool-kit** (`packages/mcp-kit`): pagination, response formatting (concise/detailed), TTL
  caching, rate-limit backoff, actionable tool errors, attribution helpers, and the bearer/OAuth auth
  every server uses identically.

## Connecting

Once deployed, add any server to Claude Code as a remote MCP server with a custom header:

```bash
claude mcp add --transport http nz-transport-mcp https://mcp.yourdomain.com/nz-transport/mcp \
  --header "Authorization: Bearer <your MCP_SHARED_TOKEN>"
```

For claude.ai / Claude mobile, add a custom connector with just the `/{slug}/mcp` URL — no header field
exists in that flow; the OAuth login covers it, working the same way for every server (there is no
more per-server "enable OAuth" step — see [docs/SETUP.md](docs/SETUP.md)). The gateway's **Connect**
page (`https://mcp.yourdomain.com/admin/connect`, once you're logged in via Cloudflare Access) renders
both the `claude mcp add` command and the plain `/{slug}/mcp` URL for every server.

These MCPs are **not public** — only someone holding your `MCP_SHARED_TOKEN`, or holding a valid OAuth
access token issued by the gateway's `/authorize` (which itself requires your Cloudflare Access
login), can call them. Only you (or whoever you grant Cloudflare Access to) can reach `/admin` to
manage credentials.

## Getting started

- **[docs/SETUP.md](docs/SETUP.md)** — deploy your own instance: Cloudflare account setup, provisioning
  D1/KV/Access, deploying the gateway, DNS.
- **[docs/API_KEYS.md](docs/API_KEYS.md)** — how to obtain every upstream API key this collection can use
  (and which APIs need no key at all).
- **[docs/ADDING_A_SERVER.md](docs/ADDING_A_SERVER.md)** — add a new domain server to the collection,
  following the same conventions as the other seven.

## Repo layout

```
packages/
  mcp-kit/        shared tool-building utilities (pagination, caching, auth, errors, attribution)
  credentials/    shared D1-backed encrypted credential store
apps/
  gateway/        the one deployed Worker — OAuth machinery, server registry, wrangler.jsonc
  portal/         credential-management web app (Hono), mounted by the gateway under /admin
servers/
  nz-govt-mcp/    (and 6 more — one directory per MCP server, no wrangler.jsonc of its own)
docs/
  SETUP.md
  API_KEYS.md
  ADDING_A_SERVER.md
  research-mcp-best-practices.md
```

## Stack

TypeScript, [Zod](https://zod.dev) v4 schemas, the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) via Cloudflare's
[Agents SDK](https://developers.cloudflare.com/agents/), [Hono](https://hono.dev) for the portal,
[Vitest](https://vitest.dev) + [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
for tests (running against a real `workerd` runtime, not mocks, except the portal — see
[CLAUDE.md](CLAUDE.md)), pnpm workspaces.

## License

MIT — see [LICENSE](LICENSE).
