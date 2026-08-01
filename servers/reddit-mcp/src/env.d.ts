// Bindings and secrets are hand-typed here — see servers/nz-govt-mcp/src/env.d.ts for why (no
// local wrangler.jsonc; that config lives at apps/gateway/wrangler.jsonc).
//
// Unlike wikimedia-mcp and ia-mcp, whose upstream credentials are optional, this server needs
// PORTAL_URL: Reddit blocks every unauthenticated API request (verified live — anonymous
// `.json` endpoints and oauth.reddit.com both return 403), so *every* tool here fails with a
// missing-credential error until the operator sets the Reddit app credentials. That error has to
// be able to name the portal page where they get set.
import type { CacheNamespace } from "@iolab/mcp-kit";
import type { D1LikeDatabase } from "@iolab/credentials";

export {};

declare global {
  interface Env {
    /**
     * TTL cache for post and comment reads, subreddit metadata, listings, and the short-lived
     * Reddit OAuth access token. See CACHE_TTL in @iolab/mcp-kit and src/auth.ts.
     */
    MCP_CACHE: CacheNamespace;
    /** D1-backed encrypted credential store, shared across every server. See @iolab/credentials. */
    CREDENTIALS_DB: D1LikeDatabase;
    /**
     * Base URL of the operator's deployed credential portal, used only to build the actionable
     * link in missing-credential error messages. Set via `wrangler secret put PORTAL_URL`.
     */
    PORTAL_URL: string;
    /**
     * Base64-encoded AES-256-GCM key used to decrypt upstream API keys stored in CREDENTIALS_DB.
     * Shared across every worker in the collection. Set via `wrangler secret put ENCRYPTION_KEY`.
     */
    ENCRYPTION_KEY: string;
  }
}
