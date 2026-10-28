// Bindings and secrets are hand-typed here — see servers/nz-govt-mcp/src/env.d.ts for why (no
// local wrangler.jsonc; that config lives at apps/gateway/wrangler.jsonc). No PORTAL_URL: unlike
// every other server, no tool here ever throws a missing-credential error — the archive.org S3
// keys are optional and every tool works fully without them (see docs/SETUP.md and this server's
// README for why keys were plumbed in despite that).
import type { CacheNamespace } from "@iolab/mcp-kit";
import type { D1LikeDatabase } from "@iolab/credentials";

export {};

declare global {
  interface Env {
    /** TTL cache for immutable Wayback captures and archive.org item text. See CACHE_TTL in @iolab/mcp-kit. */
    MCP_CACHE: CacheNamespace;
    /** D1-backed encrypted credential store, shared across every server. See @iolab/credentials. */
    CREDENTIALS_DB: D1LikeDatabase;
    /**
     * Base64-encoded 32-byte AES-256-GCM key used to decrypt the optional archive.org S3-style
     * keys stored in CREDENTIALS_DB, if set. Set via `wrangler secret put ENCRYPTION_KEY`.
     */
    ENCRYPTION_KEY: string;
    /**
     * Optional home proxy for web.archive.org (synology-docker repo, `wayback-proxy/`), e.g.
     * `https://wayback.example.com`. Both this and WAYBACK_PROXY_KEY must be set to use it;
     * otherwise Wayback is called directly. Set via `wrangler secret put WAYBACK_PROXY_URL`.
     */
    WAYBACK_PROXY_URL?: string;
    /** Shared secret sent to that proxy as `X-Wayback-Key`. Set via `wrangler secret put WAYBACK_PROXY_KEY`. */
    WAYBACK_PROXY_KEY?: string;
  }
}
