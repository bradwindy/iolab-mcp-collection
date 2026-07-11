import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The OAuth provider's module-scope construction adds cold-start cost on top of the bearer-only
  // path; under heavy concurrent load (e.g. every package's suite running at once in CI) the
  // default 5s timeout has been observed to trip on nothing more than resource contention.
  test: { testTimeout: 15000 },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MCP_SHARED_TOKEN: "test-shared-token",
          PORTAL_URL: "https://mcp.example.com",
          // Test-only 32-byte AES-256-GCM key (base64), generated with generateEncryptionKey().
          // Never use this value outside of tests.
          ENCRYPTION_KEY: "I8nrTRRjuNtTIMGe1j5pyd5B1BekIrej5XbMrmSFFEI=",
          ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-aud-tag",
          ACCESS_EMAIL: "operator@example.com",
        },
      },
    }),
  ],
});
