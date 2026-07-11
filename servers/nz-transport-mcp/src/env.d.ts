// Bindings (KV, D1, Durable Objects) are generated into worker-configuration.d.ts by `wrangler types`.
// Secrets aren't declared in wrangler.jsonc, so they're typed here by hand. OAUTH_KV is a binding
// (declared in wrangler.jsonc), so `wrangler types` provides it; OAUTH_PROVIDER is injected into
// `env` at runtime by @cloudflare/workers-oauth-provider itself, so it's hand-typed like a secret.
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

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
     * Base64-encoded 256-bit AES-GCM key shared by every server that reads/writes the
     * CREDENTIALS_DB D1 table. Set via `wrangler secret put ENCRYPTION_KEY`.
     */
    ENCRYPTION_KEY: string;
    /** Injected by @cloudflare/workers-oauth-provider; see `buildOAuthMcpWorker` in @nz-mcp/mcp-kit. */
    OAUTH_PROVIDER: OAuthHelpers;
    /**
     * This server's Cloudflare Zero Trust team domain, e.g. `myteam.cloudflareaccess.com`, used to
     * verify the Access JWT on `/authorize`. Set via `wrangler secret put ACCESS_TEAM_DOMAIN`.
     */
    ACCESS_TEAM_DOMAIN: string;
    /**
     * Audience (AUD) tag of the Access application scoped to this server's `/authorize` path.
     * Set via `wrangler secret put ACCESS_AUD`.
     */
    ACCESS_AUD: string;
    /**
     * The single operator email allowed to complete the OAuth login at `/authorize`.
     * Set via `wrangler secret put ACCESS_EMAIL`.
     */
    ACCESS_EMAIL: string;
  }
}
