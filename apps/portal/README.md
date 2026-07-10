# apps/portal

The credential-management web app for the collection. Not an MCP server — a plain
[Hono](https://hono.dev) app on Cloudflare Workers, gated end-to-end by
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) restricted to the operator's own
email. See [`README.md`](../../README.md#architecture) at the repo root for how this fits with the 7 MCP
servers.

## Pages

| Route | What it does |
|---|---|
| `GET /` | Dashboard — every server in the collection, its subdomain, and which of its required upstream credentials are set (`isSet`/`updatedAt`, never the decrypted value). |
| `GET /servers/:slug` | Per-server credential form — one password-type input per required key, each linking to its signup page. Submitting a blank value clears the credential. |
| `POST /servers/:slug` | Encrypts the submitted value (AES-256-GCM) and writes it to the shared `CREDENTIALS_DB` D1 table, keyed by `(slug, key_name)`. Validates `key_name` against the server's declared credential keys before touching D1. |
| `GET /connect` | Renders a ready-to-paste `claude mcp add` command per server, with the live `MCP_SHARED_TOKEN` filled in. `Cache-Control: no-store` — this is the only page that ever renders the token. |

## Security model

- **Auth**: entirely delegated to Cloudflare Access, configured at the Cloudflare edge — this app has no
  login code of its own. If a request reaches the Worker, Access has already authenticated it.
- **Credentials are write-only from the UI's perspective**: a previously-set value is never rendered back
  into a form. The dashboard and server pages only ever show whether a key is set and when it was last
  updated.
- **HTML escaping**: every template uses Hono's `html` tagged-template helper, which auto-escapes all
  interpolated values. The one `raw()` call in the codebase (`views/layout.ts`) wraps static, hand-written
  CSS with no user or database input.
- **CSRF surface**: the only state-changing route is the one `POST /servers/:slug`; every other route is
  a read-only `GET`.

## Local development

```bash
pnpm exec wrangler types
pnpm exec wrangler dev
```

Cloudflare Access doesn't run locally — `wrangler dev` serves the app directly, unauthenticated, so you
can iterate on the UI without needing an Access session. Don't expose a local dev server publicly.

## Testing

`pnpm exec vitest run` — plain Vitest (not `@cloudflare/vitest-pool-workers`), using a fake `D1LikeDatabase`
matching `@nz-mcp/credentials`' interface (mirrored from `packages/credentials/test/store.test.ts`) and
Hono's own `app.request()` test helper. See [`packages/credentials`](../../packages/credentials) for the
actual encryption/storage implementation this app depends on.
