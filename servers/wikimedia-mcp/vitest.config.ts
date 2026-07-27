import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // See servers/nz-govt-mcp/vitest.config.ts for why: this server has no wrangler.jsonc of its
  // own, so tests run against the shared gateway config, whose module scope constructs every
  // registered agent plus the shared OAuthProvider.
  test: { testTimeout: 15000 },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../apps/gateway/wrangler.jsonc" },
    }),
  ],
});
