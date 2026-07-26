# apps/portal

The credential-management web app for the collection. Not an MCP server, and not its own deployable
Worker anymore — a plain [Hono](https://hono.dev) app (`"exports": { ".": "./src/app.ts" }`) mounted
by `apps/gateway` as the OAuth provider's `defaultHandler`, under `/admin/*`. See
[`README.md`](../../README.md#architecture) at the repo root for how this fits with the gateway and
the 7 MCP servers.

## Pages

| Route | Access | What it does |
|---|---|---|
| `GET /` | Public | Minimal landing page — no server list, no credential status, no secrets. |
| `GET /admin` | `/admin/*` guard | Dashboard — every server in the collection, its gateway URL, and which of its required upstream credentials are set (`isSet`/`updatedAt`, never the decrypted value). |
| `GET /admin/servers/:slug` | `/admin/*` guard | Per-server credential form — one password-type input per required key, each linking to its signup page. Submitting a blank value clears the credential. |
| `POST /admin/servers/:slug` | `/admin/*` guard | Encrypts the submitted value (AES-256-GCM) and writes it to the shared `CREDENTIALS_DB` D1 table, keyed by `(slug, key_name)`. Validates `key_name` against the server's declared credential keys before touching D1. |
| `GET /admin/connect` | `/admin/*` guard | Renders a ready-to-paste `claude mcp add` command per server, with the live `MCP_SHARED_TOKEN` filled in. `Cache-Control: no-store` — this is the only page that ever renders the token. |

## Security model

- **Auth is checked in application code, not delegated to Cloudflare Access at the edge.** This is a
  deliberate change from when this app was its own Worker on its own hostname (entirely covered by an
  Access application). The gateway's shared hostname must also serve `/token`, `/register`, and
  `/.well-known/*` publicly for machine-to-machine OAuth calls, so Access there is scoped to
  `/authorize` only — `app.ts` runs `verifyAccessJwt` (from `@iolab/mcp-kit/access`) as Hono
  middleware on every `/admin/*` request instead, checking the same Access session `/authorize`
  establishes (the `CF_Authorization` cookie is domain-wide once that login completes). A routing
  mistake here is a 403 from this check, not a credential leak.
- **Credentials are write-only from the UI's perspective**: a previously-set value is never rendered back
  into a form. The dashboard and server pages only ever show whether a key is set and when it was last
  updated.
- **HTML escaping**: every template uses Hono's `html` tagged-template helper, which auto-escapes all
  interpolated values. The one `raw()` call in the codebase (`views/layout.ts`) wraps static, hand-written
  CSS with no user or database input.
- **CSRF surface**: the only state-changing route is the one `POST /admin/servers/:slug`; every other
  route is a read-only `GET`.

## Local development

This package has no `wrangler.jsonc` of its own — run the gateway instead:

```bash
cd ../gateway && pnpm exec wrangler dev
```

Cloudflare Access doesn't run locally, and `/admin/*`'s guard needs a real Access JWT — either sign a
test one the way `test/support/accessJwt.ts` does, or temporarily stub `verifyAccessJwt`'s import for
local iteration. Don't expose a local dev server publicly.

## Testing

`pnpm exec vitest run` — plain Vitest (not `@cloudflare/vitest-pool-workers`), using a fake `D1LikeDatabase`
matching `@iolab/credentials`' interface (mirrored from `packages/credentials/test/store.test.ts`),
Hono's own `app.request()` test helper, and a locally-signed Access JWT (`test/support/accessJwt.ts`,
reusing the same JWKS-override test seam `@iolab/mcp-kit`'s own OAuth tests use) for the `/admin/*`
routes. `@iolab/mcp-kit`'s main barrel isn't imported here — only the dedicated
`@iolab/mcp-kit/access` subpath, which has no dependency on `@cloudflare/workers-oauth-provider`
(whose dist bundle imports `cloudflare:workers` at module scope and would break under plain Node — see
`packages/mcp-kit/src/access.ts`'s top comment). See [`packages/credentials`](../../packages/credentials)
for the actual encryption/storage implementation this app depends on.
