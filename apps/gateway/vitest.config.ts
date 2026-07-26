import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // See servers/*/vitest.config.ts for why: constructing every registered agent plus the shared
  // OAuthProvider at module scope is real cold-start cost, and under heavy concurrent CI load the
  // default 5s test timeout has been observed to trip on nothing more than resource contention.
  test: { testTimeout: 15000 },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MCP_SHARED_TOKEN: "test-shared-token",
          PORTAL_URL: "https://mcp.example.com",
          ENCRYPTION_KEY: "NOnV4EUJ4r07rvPzrNy6SGdvJPCoAJQL+j7i2004jpo=",
          BASE_DOMAIN: "example.com",
          ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.com",
          ACCESS_AUD: "test-aud-tag",
          ACCESS_EMAIL: "operator@example.com",
        },
      },
    }),
  ],
});
