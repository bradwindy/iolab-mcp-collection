// Bindings (KV, D1, Durable Objects) are generated into worker-configuration.d.ts by `wrangler types`.
// Secrets aren't declared in wrangler.jsonc, so they're typed here by hand.
//
// Two Env types need augmenting, not one: `wrangler types` generates both a global ambient
// `Env` interface (used throughout this codebase, e.g. `fetch(request, env: Env, ctx)`) and a
// separate `Cloudflare.Env` (used by the newer `import { env } from "cloudflare:workers"`, which
// test files here use). They don't merge with each other, so secrets have to be declared on both
// or `cloudflare:workers`' `env` won't type-check against handlers expecting the global `Env`.
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
     * Base64-encoded 32-byte AES-256-GCM key used to decrypt upstream API credentials
     * stored in the shared CREDENTIALS_DB. Must match the key the portal used to encrypt
     * them. Set via `wrangler secret put ENCRYPTION_KEY`.
     */
    ENCRYPTION_KEY: string;
  }

  namespace Cloudflare {
    interface Env {
      /** Shared bearer token every MCP client must present. Set via `wrangler secret put MCP_SHARED_TOKEN`. */
      MCP_SHARED_TOKEN: string;
      /**
       * Base URL of the operator's deployed credential portal, used only to build the
       * actionable link in missing-credential error messages. Set via `wrangler secret put PORTAL_URL`.
       */
      PORTAL_URL: string;

      /**
       * Base64-encoded 32-byte AES-256-GCM key used to decrypt upstream API credentials
       * stored in the shared CREDENTIALS_DB. Must match the key the portal used to encrypt
       * them. Set via `wrangler secret put ENCRYPTION_KEY`.
       */
      ENCRYPTION_KEY: string;
    }
  }
}
