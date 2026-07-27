// Bindings and secrets are hand-typed here — see servers/nz-govt-mcp/src/env.d.ts for why (no
// local wrangler.jsonc; that config lives at apps/gateway/wrangler.jsonc). No PORTAL_URL: like
// ia-mcp and unlike the NZ servers, no tool here ever throws a missing-credential error — the
// Wikimedia OAuth token is optional and every tool works fully without it (see src/credentials.ts
// and this server's README for what it does and doesn't buy).
import type { CacheNamespace } from "@iolab/mcp-kit";
import type { D1LikeDatabase } from "@iolab/credentials";

export {};

declare global {
  interface Env {
    /** TTL cache for wiki page reads, Commons file metadata, and Wikidata entities. See CACHE_TTL in @iolab/mcp-kit. */
    MCP_CACHE: CacheNamespace;
    /** D1-backed encrypted credential store, shared across every server. See @iolab/credentials. */
    CREDENTIALS_DB: D1LikeDatabase;
    /**
     * Base64-encoded 32-byte AES-256-GCM key used to decrypt the optional Wikimedia OAuth 2.0
     * token stored in CREDENTIALS_DB, if set. Set via `wrangler secret put ENCRYPTION_KEY`.
     */
    ENCRYPTION_KEY: string;
  }
}
