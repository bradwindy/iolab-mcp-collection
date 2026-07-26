# @iolab/mcp-kit

Shared tool-building utilities every server in this collection imports from — the conventions from
[`docs/research-mcp-best-practices.md`](../../docs/research-mcp-best-practices.md) implemented
once, not seven times. Internal workspace package, not published to npm.

| Module | Exports |
|---|---|
| `pagination.ts` | `normalizeLimit`, `normalizeOffset`, `paginate` (in-memory arrays), `describePage` (server-paginated APIs) |
| `response.ts` | `jsonResult` (wraps a plain object as both `content` text and `structuredContent`), `selectFormat` (concise/detailed), `truncationNotice` |
| `errors.ts` | `toolError`, `upstreamError`, `missingCredentialError`, `UpstreamHttpError` |
| `attribution.ts` | `attribution(source, { license?, url? })` |
| `annotations.ts` | `READ_ONLY_OPEN_WORLD_ANNOTATIONS` — spread into every tool's `annotations` |
| `cache.ts` | `cached()` (KV cache-aside), `CACHE_TTL` (`METADATA`/`SLOW_MOVING`/`NEAR_REALTIME` — note the 60s floor: Workers KV rejects any `expirationTtl` below 60) |
| `retry.ts` | `fetchWithBackoff` — exponential backoff + jitter, respects `Retry-After` |
| `auth.ts` | `requireBearerToken` — the shared-token gate every server's `index.ts` runs before routing to its `McpAgent` |
| `schemas.ts` | `limitParam`, `offsetParam`, `responseFormatParam` — reusable Zod input fragments |

Zero Cloudflare-specific dependency beyond what any server already needs (`Request`/`Response`/`crypto`
via the `dom` lib) — this package doesn't install `@cloudflare/workers-types` and doesn't need a
`wrangler.jsonc` of its own.

## Testing

`pnpm exec vitest run` — plain Vitest, no Workers runtime needed (pure logic, Web-standard APIs only).
