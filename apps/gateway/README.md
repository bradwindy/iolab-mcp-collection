# apps/gateway

The one deployed Cloudflare Worker for the whole collection. Owns:

- `wrangler.jsonc` — the only real Cloudflare config left in this repo (KV, D1, Durable Object
  bindings for every registered server, the one Custom Domain route).
- `src/servers.ts` — the server registry: URL slug → agent class → Durable Object binding name. This
  is what `src/index.ts` and `wrangler.jsonc`'s bindings both derive from; see
  [`docs/ADDING_A_SERVER.md`](../../docs/ADDING_A_SERVER.md) §6 for how to register a new server.
- `src/index.ts` — composes `buildMultiServerOAuthWorker` (`@iolab/mcp-kit`) over the registry and
  the mounted portal (`@iolab/portal`). Re-exports every registered Durable Object class, since
  `wrangler.jsonc`'s `durable_objects.bindings[].class_name` must resolve against a top-level export
  of this module.
- `src/env.d.ts` — the one place every secret (`MCP_SHARED_TOKEN`, `PORTAL_URL`, `ENCRYPTION_KEY`,
  `BASE_DOMAIN`, `ACCESS_*`, `DISABLE_RESOURCE_ENFORCEMENT`) is hand-typed. No `servers/*` package or
  `apps/portal` declares these anymore — see [`CLAUDE.md`](../../CLAUDE.md) for the full split.

See [`docs/SETUP.md`](../../docs/SETUP.md) for provisioning and deploying your own instance, and the
repo root [`README.md`](../../README.md#architecture) for the overall architecture diagram.

## Local development

```bash
pnpm exec wrangler types
cp .dev.vars.example .dev.vars   # fill in real values — never commit .dev.vars
pnpm exec wrangler dev
```

## Testing

`pnpm exec vitest run` — against a real `workerd` runtime via `@cloudflare/vitest-pool-workers`,
pointed at this package's own `wrangler.jsonc`. `test/oauth.test.ts` and
`test/multi-server-security.test.ts` are the consolidated OAuth flow and multi-server-specific
security suites (see their own top comments for what moved from where); `test/bearer.test.ts` and
`test/portal.test.ts` cover the static bearer-token gate and the portal mount respectively.
`servers/*` packages' own `vitest.config.ts` files point their `wrangler.configPath` at this
package's `wrangler.jsonc` too, so their tool-level tests run against the same shared config.
