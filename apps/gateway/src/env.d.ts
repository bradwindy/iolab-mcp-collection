// Bindings (KV, D1, Durable Objects) are generated into worker-configuration.d.ts by
// `wrangler types`. Secrets aren't declared in wrangler.jsonc, so they're typed here by hand —
// this is now the ONE place they're declared, shared by every registered server (via `Env`), the
// mounted portal, and the OAuth machinery in @iolab/mcp-kit.
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export {};

declare global {
  interface Env {
    /** Shared bearer token every MCP client must present. Set via `wrangler secret put MCP_SHARED_TOKEN`. */
    MCP_SHARED_TOKEN: string;
    /**
     * Base URL of this deployed gateway, used only to build the actionable link in
     * missing-credential error messages. Set via `wrangler secret put PORTAL_URL`.
     */
    PORTAL_URL: string;
    /**
     * Base64-encoded 32-byte AES-256-GCM key used to encrypt/decrypt every credential at rest.
     * Set via `wrangler secret put ENCRYPTION_KEY` (generate with `generateEncryptionKey()` from
     * @iolab/credentials).
     */
    ENCRYPTION_KEY: string;
    /**
     * Bare base domain (no protocol, no subdomain) this gateway is deployed behind, e.g.
     * "example.com" for a gateway at mcp.example.com. Set via `wrangler secret put BASE_DOMAIN`.
     */
    BASE_DOMAIN: string;
    /** Injected by @cloudflare/workers-oauth-provider; see `buildMultiServerOAuthWorker` in @iolab/mcp-kit. */
    OAUTH_PROVIDER: OAuthHelpers;
    /**
     * This gateway's Cloudflare Zero Trust team domain, e.g. `myteam.cloudflareaccess.com`, used
     * to verify the Access JWT on /authorize and (via the portal's own check) /admin/*.
     * Set via `wrangler secret put ACCESS_TEAM_DOMAIN`.
     */
    ACCESS_TEAM_DOMAIN: string;
    /**
     * Audience (AUD) tag of the one Access application scoped to /authorize.
     * Set via `wrangler secret put ACCESS_AUD`.
     */
    ACCESS_AUD: string;
    /**
     * The single operator email allowed to complete the OAuth login at /authorize (and, via the
     * portal's own check, to use /admin/*). Set via `wrangler secret put ACCESS_EMAIL`.
     */
    ACCESS_EMAIL: string;
    /**
     * Escape hatch for cutover — see OAuthMcpEnv in @iolab/mcp-kit's oauth.ts for the full
     * explanation. Leave unset; only set to the exact string "true" if a real OAuth client turns
     * out not to send an RFC 8707 `resource` parameter the way claude.ai is expected to.
     */
    DISABLE_RESOURCE_ENFORCEMENT?: string;
  }
}
