# @nz-mcp/credentials

The shared, encrypted credential store: the portal writes upstream API keys here; every MCP server reads
and decrypts them at request time. Internal workspace package, not published to npm.

## Storage model

One D1 database (`nz-mcp-credentials`), one table:

```sql
CREATE TABLE credentials (
  server TEXT NOT NULL,      -- matches the reading/writing server's wrangler.jsonc "name"
  key_name TEXT NOT NULL,    -- e.g. "LINZ_API_KEY"
  value TEXT NOT NULL,       -- base64(iv[12] || AES-256-GCM ciphertext+tag)
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server, key_name)
);
```

Every value is encrypted with AES-256-GCM (`crypto.ts`) using a 256-bit key from the `ENCRYPTION_KEY`
Worker secret — identical across the portal and every server, since the portal encrypts what the
operator types in and a server needs the same key to decrypt it back out. Generate one with
`generateEncryptionKey()`; see [`docs/SETUP.md`](../../docs/SETUP.md) for the one-time setup flow.

## API (`store.ts`)

- `setCredential(db, server, keyName, plaintextValue, encryptionKey)` — encrypt and upsert.
- `getCredential(db, server, keyName, encryptionKey)` — fetch and decrypt; `null` if unset.
- `deleteCredential(db, server, keyName)` — remove a row (the portal uses this when a form is submitted
  blank).
- `listCredentialStatus(db, server, requiredKeyNames)` — reports `isSet`/`updatedAt` per key **without
  ever decrypting** — what the portal's dashboard uses.

All queries are parameterized via D1's `.bind()` — no string-concatenated SQL anywhere in this package.

`D1LikeDatabase`/`D1LikeStatement` are minimal structural interfaces (not the full `@cloudflare/workers-types`
`D1Database`) so tests can pass a small in-memory fake instead of a real D1 binding — see `test/store.test.ts`
for the reference fake, reused verbatim by several servers' own test suites.

## Testing

`pnpm exec vitest run` — plain Vitest; `crypto.subtle`/`TextEncoder`/`btoa`/`atob` are available as
Node 22 globals, no Workers runtime needed.
