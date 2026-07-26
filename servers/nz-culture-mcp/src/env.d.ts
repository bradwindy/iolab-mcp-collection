// Bindings and secrets are now fully hand-typed here — this server no longer has its own
// wrangler.jsonc, so there's no local `wrangler types` run to generate worker-configuration.d.ts
// (that config now lives at apps/gateway/wrangler.jsonc, which the gateway owns). MCP_CACHE and
// CREDENTIALS_DB used to come from real generated KVNamespace/D1Database types; they're typed here
// against this repo's own minimal structural interfaces (CacheNamespace, D1LikeDatabase) instead
// of @cloudflare/workers-types, which this repo deliberately avoids depending on. OAuth/bearer-gate
// fields (MCP_SHARED_TOKEN, OAUTH_PROVIDER, ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_EMAIL) moved to
// the gateway along with the auth gate itself — this server's own src/ code never reads them.
import type { CacheNamespace } from "@iolab/mcp-kit";
import type { D1LikeDatabase } from "@iolab/credentials";

export {};

declare global {
  interface Env {
    /** TTL cache for slow-changing upstream responses. See CACHE_TTL in @iolab/mcp-kit. */
    MCP_CACHE: CacheNamespace;
    /** D1-backed encrypted credential store, shared across every server. See @iolab/credentials. */
    CREDENTIALS_DB: D1LikeDatabase;
    /**
     * Base URL of the operator's deployed credential portal, used only to build the
     * actionable link in missing-credential error messages. Set via `wrangler secret put PORTAL_URL`.
     */
    PORTAL_URL: string;
    /**
     * Base64-encoded 32-byte AES-256-GCM key used to encrypt/decrypt credential values stored in
     * CREDENTIALS_DB (see @iolab/credentials). Set via `wrangler secret put ENCRYPTION_KEY`.
     * Generate one with `generateEncryptionKey()` from @iolab/credentials — it must be the SAME
     * key the portal used to write the credential, since this server only decrypts, never writes.
     */
    ENCRYPTION_KEY: string;
  }
}
