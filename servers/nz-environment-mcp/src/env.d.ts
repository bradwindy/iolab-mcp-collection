// Bindings (KV, D1, Durable Objects) are generated into worker-configuration.d.ts by
// `wrangler types`. Secrets aren't declared in wrangler.jsonc, so they're typed here by hand.
export {};

declare global {
  interface Env {
    /** Shared bearer token every MCP client must present. Set via `wrangler secret put MCP_SHARED_TOKEN`. */
    MCP_SHARED_TOKEN: string;
    /**
     * Base URL of the operator's deployed credential portal, used only to build the
     * actionable link in missing-credential error messages. Set via `wrangler secret put PORTAL_URL`.
     */
    PORTAL_URL: string;
    /**
     * Base64-encoded 32-byte AES-256-GCM key used to decrypt upstream API keys stored in
     * CREDENTIALS_DB. Set via `wrangler secret put ENCRYPTION_KEY`. Generate one with
     * `generateEncryptionKey()` from "@nz-mcp/credentials" and reuse the SAME value across
     * every server that shares the CREDENTIALS_DB database.
     */
    ENCRYPTION_KEY: string;
  }
}
