# nz-mcp-collection

A collection of remote [MCP](https://modelcontextprotocol.io) servers exposing free and self-service
New Zealand public APIs to Claude (or any MCP client), clustered by research domain and hosted on
Cloudflare Workers.

Built from the API inventory in [api-catalog](https://github.com/bradwindy/api-catalog) (24 NZ public
APIs) following the clustering and tool-design guidance in
[`docs/nz-research-mcp-best-practices.md`](docs/nz-research-mcp-best-practices.md): cluster by research
domain rather than one-server-per-API or one-giant-server, design tools around research questions rather
than 1:1 endpoint wraps, paginate everything, and keep response payloads lean.

## The servers

| Server | Domain | Tools | Upstream APIs |
|---|---|---|---|
| [`nz-govt-mcp`](servers/nz-govt-mcp) | Civic & open data | 7 | Charities Register, data.govt.nz, Auckland Council Open Data, Education Counts (Schools + ECE) |
| [`nz-culture-mcp`](servers/nz-culture-mcp) | Digital heritage & museums | 4 | DigitalNZ, Te Papa Collections |
| [`nz-stats-mcp`](servers/nz-stats-mcp) | Official statistics | 4 | Stats NZ Aotearoa Data Explorer (SDMX) |
| [`nz-geo-mcp`](servers/nz-geo-mcp) | Geospatial & property | 6 | LINZ Data Service, LINZ Basemaps, Canterbury Maps |
| [`nz-environment-mcp`](servers/nz-environment-mcp) | Hazards, weather & climate | 9 | GeoNet, GeoNet FDSN, NIWA Tides/UV/CO2 |
| [`nz-transport-mcp`](servers/nz-transport-mcp) | Traffic & transport | 10 | Auckland Transport, NZTA Traffic & Travel, NZTA TMS/MVR/Licence datasets |
| [`nz-markets-mcp`](servers/nz-markets-mcp) | Lending rates & markets | 7 | Rates API, NZXplorer, Electricity Authority EMI |

Every server:

- exposes tools designed around research questions, not raw endpoints (`nz_{domain}_verb_noun`, always
  paginated, always attributed to its upstream source and license)
- runs read-only, with `readOnlyHint`/`openWorldHint` annotations on every tool
- is a Cloudflare Worker using the [Agents SDK](https://developers.cloudflare.com/agents/)'s `McpAgent`,
  served over Streamable HTTP
- gates its `/mcp` endpoint behind a single shared bearer token, and optionally OAuth 2.1 for
  claude.ai (see [Connecting](#connecting) below)
- reads any upstream API keys it needs from a shared, AES-256-GCM-encrypted D1 store — see
  [Architecture](#architecture)

Each server's own README documents its exact tools, required upstream credentials (if any), and example
research questions it can answer.

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │   Cloudflare Access (email OTP)          │
                    │   gates the portal only                  │
                    └───────────────────┬───────────────────────┘
                                        │
                            https://mcp.yourdomain.com
                    ┌───────────────────▼───────────────────────┐
                    │              apps/portal                   │
                    │  dashboard · per-server credential forms   │
                    │  · Connect page (claude mcp add examples)  │
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
   (7 servers, each its own Worker + Durable Object, bearer-token gated at /mcp)
        │               │               │               │               │              │
        ▼               ▼               ▼               ▼               ▼              ▼
   live NZ public / self-service APIs (Charities Register, GeoNet, LINZ, NIWA, Stats NZ, AT, NZTA, ...)
```

- **Portal** (`apps/portal`): a plain Cloudflare Worker (Hono), gated by
  [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) restricted to the
  operator's own identity via email OTP. This is where you paste in your upstream API keys — they're
  encrypted with AES-256-GCM before being written to D1, and the portal never renders a previously-set
  value back into a form.
- **Shared credential store** (`packages/credentials`): one D1 database, one `ENCRYPTION_KEY` Worker
  secret shared across the portal and every server. The portal writes; each server reads and decrypts at
  request time. Neither the repo nor any AI agent that helped build it ever saw a real upstream key —
  Cloudflare secrets are write-only by design.
- **MCP servers** (`servers/*`): each is an independent Worker/Durable Object pair on its own subdomain.
  `/mcp` accepts a shared bearer token (`MCP_SHARED_TOKEN`), checked in application code before the
  request reaches the MCP handler — this is what Claude Code uses, since it connects server-to-server and
  can't complete an interactive login. Each server can also run its own OAuth 2.1 + PKCE
  authorization/resource server (`@cloudflare/workers-oauth-provider`), gated by Cloudflare Access on the
  `/authorize` path only, for claude.ai's custom-connector flow — see [docs/SETUP.md §8](docs/SETUP.md#8-oauth-for-claudeai-optional).
  Both paths work at once on the same server; OAuth is opt-in per server.
- **Shared tool-kit** (`packages/mcp-kit`): pagination, response formatting (concise/detailed), TTL
  caching, rate-limit backoff, actionable tool errors, attribution helpers, and the bearer-auth middleware
  every server uses identically.

## Connecting

Once deployed, add any server to Claude Code as a remote MCP server with a custom header:

```bash
claude mcp add --transport http nz-transport-mcp https://nz-transport.mcp.yourdomain.com/mcp \
  --header "Authorization: Bearer <your MCP_SHARED_TOKEN>"
```

For claude.ai / Claude mobile, add a custom connector with just the `/mcp` URL — no header field exists
in that flow, so servers you want to use there need [OAuth enabled](docs/SETUP.md#8-oauth-for-claudeai-optional)
instead. The portal's **Connect** page (`https://<your-portal-domain>/connect`, once you're logged in via
Cloudflare Access) renders both the `claude mcp add` command and the plain `/mcp` URL for every server.

These MCPs are **not public** — only someone holding your `MCP_SHARED_TOKEN` can call them, and only you
(or whoever you grant Cloudflare Access to) can reach the portal to manage credentials.

## Getting started

- **[docs/SETUP.md](docs/SETUP.md)** — deploy your own instance: Cloudflare account setup, provisioning
  D1/KV/Access, deploying every server and the portal, DNS.
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
  portal/         credential-management web app (Hono, Cloudflare Access-gated)
servers/
  nz-govt-mcp/    (and 6 more — one directory per MCP server)
docs/
  SETUP.md
  API_KEYS.md
  ADDING_A_SERVER.md
  nz-research-mcp-best-practices.md
```

## Stack

TypeScript, [Zod](https://zod.dev) v4 schemas, the official
[`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) via Cloudflare's
[Agents SDK](https://developers.cloudflare.com/agents/), [Hono](https://hono.dev) for the portal,
[Vitest](https://vitest.dev) + [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
for tests (running against a real `workerd` runtime, not mocks), pnpm workspaces.

## License

MIT — see [LICENSE](LICENSE).
