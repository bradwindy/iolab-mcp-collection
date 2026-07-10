// The CREDENTIALS_DB binding is declared in wrangler.jsonc (d1_databases) and typed
// automatically into worker-configuration.d.ts by `wrangler types`. Secrets aren't
// declared in wrangler.jsonc, so they're typed here by hand.
export {};

declare global {
  interface Env {
    /**
     * Base64-encoded 256-bit AES-GCM key used to encrypt/decrypt every credential at rest.
     * Shared across every worker in this repo that binds CREDENTIALS_DB — set once via
     * `wrangler secret put ENCRYPTION_KEY` (generate with `generateEncryptionKey()` from
     * @nz-mcp/credentials).
     */
    ENCRYPTION_KEY: string;
    /**
     * The bearer token every MCP server in the collection requires on its /mcp endpoint.
     * Read at request time and interpolated into the Connect page's example `claude mcp add`
     * commands — never hardcoded in source and never rendered anywhere outside this
     * Access-gated portal. Set via `wrangler secret put MCP_SHARED_TOKEN`.
     */
    MCP_SHARED_TOKEN: string;
    /**
     * Bare base domain (no protocol, no subdomain) the operator's MCP servers are deployed
     * behind, e.g. "example.com". Combined with each manifest entry's relative `subdomain`
     * to build the live URLs shown on the dashboard and Connect page. Set via
     * `wrangler secret put BASE_DOMAIN`.
     */
    BASE_DOMAIN: string;
    /**
     * The operator's email, shown on the Connect page as a reminder of who Cloudflare Access
     * allows through — display text only, not itself an access control. Set via
     * `wrangler secret put ACCESS_EMAIL`.
     */
    ACCESS_EMAIL: string;
  }
}
