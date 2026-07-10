// Bindings (KV, Durable Objects) are generated into worker-configuration.d.ts by `wrangler types`.
// Secrets aren't declared in wrangler.jsonc, so they're typed here by hand.
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
  }
}
