import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // This server no longer has its own wrangler.jsonc — tests run against the shared gateway's
  // config (see apps/gateway/wrangler.jsonc), whose module scope constructs every registered
  // agent plus the shared OAuthProvider. That cost is paid once per workerd isolate boot, even for
  // a test file that only calls a tool handler directly; under heavy concurrent load (e.g. every
  // package's suite running at once in CI) the default 5s timeout has been observed to trip on
  // nothing more than resource contention.
  test: { testTimeout: 15000 },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../apps/gateway/wrangler.jsonc" },
      // Unlike the other six servers, this package's own tests (test/*.test.ts) reach the real
      // gateway runtime bindings directly via `import { env } from "cloudflare:workers"` instead
      // of building a fake Env object — see test/helpers/cache.ts and test/helpers/credentials.ts.
      // ENCRYPTION_KEY and PORTAL_URL are secrets, so they're never in wrangler.jsonc; the gateway
      // itself only gets them via `wrangler secret put` in production, and supplies test-only
      // values through this same miniflare.bindings override in apps/gateway/vitest.config.ts.
      // That override doesn't extend to this package's separate `vitest run` invocation, so it's
      // duplicated here — MCP_CACHE/CREDENTIALS_DB don't need a bindings entry since those come
      // from the real `kv_namespaces`/`d1_databases` blocks in the gateway's wrangler.jsonc, which
      // `wrangler: { configPath: ... }` above already wires up.
      miniflare: {
        bindings: {
          PORTAL_URL: "https://mcp.example.com",
          // Test-only 32-byte AES-256-GCM key (base64), generated with generateEncryptionKey().
          // Never use this value outside of tests.
          ENCRYPTION_KEY: "I8nrTRRjuNtTIMGe1j5pyd5B1BekIrej5XbMrmSFFEI=",
        },
      },
    }),
  ],
});
