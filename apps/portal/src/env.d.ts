// This package no longer has its own wrangler.jsonc — it's mounted by apps/gateway, which owns
// the real Cloudflare config and `wrangler types` generation. Every Env field this package's own
// code touches is therefore hand-typed here, including CREDENTIALS_DB (a real D1 binding in the
// gateway's wrangler.jsonc, but typed here via @iolab/credentials' minimal structural interface
// rather than depending on @cloudflare/workers-types just for this one package-local file).
import type { D1LikeDatabase } from "@iolab/credentials";

export {};

declare global {
  interface Env {
    /** The shared credentials D1 database — see apps/gateway/wrangler.jsonc. */
    CREDENTIALS_DB: D1LikeDatabase;
    /**
     * Base64-encoded 256-bit AES-GCM key used to encrypt/decrypt every credential at rest.
     * Shared across the whole gateway — set once via `wrangler secret put ENCRYPTION_KEY`
     * (generate with `generateEncryptionKey()` from @iolab/credentials).
     */
    ENCRYPTION_KEY: string;
    /**
     * The bearer token every MCP server in the collection requires on its /mcp endpoint.
     * Read at request time and interpolated into the Connect page's example `claude mcp add`
     * commands — never hardcoded in source and never rendered anywhere outside the
     * Access-in-code-gated /admin/* routes. Set via `wrangler secret put MCP_SHARED_TOKEN`.
     */
    MCP_SHARED_TOKEN: string;
    /**
     * Bare base domain (no protocol, no subdomain) the gateway is deployed behind, e.g.
     * "example.com" for a gateway at mcp.example.com. Combined with each manifest entry's
     * `pathPrefix` to build the live URLs shown on the dashboard and Connect page. Set via
     * `wrangler secret put BASE_DOMAIN`.
     */
    BASE_DOMAIN: string;
    /**
     * The operator's email, shown on the Connect page as a reminder of who Cloudflare Access
     * allows through — display text only, not itself an access control. Set via
     * `wrangler secret put ACCESS_EMAIL`.
     */
    ACCESS_EMAIL: string;
    /**
     * This gateway's Cloudflare Zero Trust team domain, used by the /admin/* access guard to
     * verify the Access session cookie/JWT. Same value as the /authorize Access app's team.
     * Set via `wrangler secret put ACCESS_TEAM_DOMAIN`.
     */
    ACCESS_TEAM_DOMAIN: string;
    /**
     * Audience (AUD) tag of the one Access application scoped to /authorize — the /admin/* guard
     * verifies against the same audience, since it's the same Access session. Set via
     * `wrangler secret put ACCESS_AUD`.
     */
    ACCESS_AUD: string;
  }
}
