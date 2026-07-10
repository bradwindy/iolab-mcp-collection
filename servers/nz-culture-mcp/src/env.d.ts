// Bindings (KV, D1, Durable Objects) are generated into worker-configuration.d.ts by `wrangler types`.
// Secrets aren't declared in wrangler.jsonc, so they're typed here by hand.
export {};

declare global {
  interface Env {
    /** Shared bearer token every MCP client must present. Set via `wrangler secret put MCP_SHARED_TOKEN`. */
    MCP_SHARED_TOKEN: string;
    /**
     * Base64-encoded 32-byte AES-256-GCM key used to encrypt/decrypt credential values stored in
     * CREDENTIALS_DB (see @nz-mcp/credentials). Set via `wrangler secret put ENCRYPTION_KEY`.
     * Generate one with `generateEncryptionKey()` from @nz-mcp/credentials — it must be the SAME
     * key the portal used to write the credential, since this server only decrypts, never writes.
     */
    ENCRYPTION_KEY: string;
  }
}
