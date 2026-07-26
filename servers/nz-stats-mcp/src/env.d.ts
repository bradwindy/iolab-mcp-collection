// Bindings and secrets are now fully hand-typed here — this server no longer has its own
// wrangler.jsonc, so there's no local `wrangler types` run to generate worker-configuration.d.ts
// (that config now lives at apps/gateway/wrangler.jsonc, which the gateway owns). MCP_CACHE and
// CREDENTIALS_DB used to come from real generated KVNamespace/D1Database types; they're typed here
// against this repo's own minimal structural interfaces (CacheNamespace, D1LikeDatabase) instead
// of @cloudflare/workers-types, which this repo deliberately avoids depending on. OAuth/bearer-gate
// fields (MCP_SHARED_TOKEN, OAUTH_PROVIDER, ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_EMAIL) moved to
// the gateway along with the auth gate itself — this server's own src/ code never reads them.
//
// Two Env types still need augmenting, not one: the global ambient `Env` interface (used
// throughout this codebase, e.g. tool handlers' `(rawInput, env: Env)`) and the separate
// `Cloudflare.Env` (used by `import { env } from "cloudflare:workers"`, which this package's own
// test files use to reach the gateway's real MCP_CACHE/CREDENTIALS_DB bindings under
// vitest-pool-workers). They don't merge with each other, so every field is declared on both.
import type { CacheNamespace } from "@iolab/mcp-kit";
import type { D1LikeDatabase } from "@iolab/credentials";

export {};

/**
 * TTL cache for slow-changing upstream responses (see CACHE_TTL in @iolab/mcp-kit), widened past
 * the plain get/put CacheNamespace shape every other server uses: this server's own test suite
 * (test/helpers/cache.ts's `clearCache`) has to purge MCP_CACHE between tests within the same
 * file, since vitest-pool-workers under Vitest 4 isolates storage per test *file*, not per test —
 * see that helper's doc comment — which needs the KV list+delete surface a cache-aside get/put
 * interface doesn't.
 */
type StatsCacheNamespace = CacheNamespace & {
  list(): Promise<{ keys: { name: string }[] }>;
  delete(key: string): Promise<void>;
};

/**
 * D1-backed encrypted credential store, shared across every server (see @iolab/credentials),
 * widened past the plain `prepare()` D1LikeDatabase shape every other server uses: this server's
 * own test suite (test/helpers/credentials.ts) runs a raw `CREATE TABLE IF NOT EXISTS` via
 * `exec()` against the real D1 binding to mirror the production schema locally, since — like
 * MCP_CACHE above — vitest-pool-workers under Vitest 4 doesn't guarantee a clean table between
 * tests in the same file.
 */
type StatsCredentialsDb = D1LikeDatabase & {
  exec(query: string): Promise<unknown>;
};

declare global {
  interface Env {
    /** TTL cache for slow-changing upstream responses. See CACHE_TTL in @iolab/mcp-kit. */
    MCP_CACHE: StatsCacheNamespace;
    /** D1-backed encrypted credential store, shared across every server. See @iolab/credentials. */
    CREDENTIALS_DB: StatsCredentialsDb;
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
      /** TTL cache for slow-changing upstream responses. See CACHE_TTL in @iolab/mcp-kit. */
      MCP_CACHE: StatsCacheNamespace;
      /** D1-backed encrypted credential store, shared across every server. See @iolab/credentials. */
      CREDENTIALS_DB: StatsCredentialsDb;
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
