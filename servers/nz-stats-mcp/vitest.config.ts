import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MCP_SHARED_TOKEN: "test-shared-token",
          // Test-only 32-byte AES-256-GCM key (base64), generated with generateEncryptionKey().
          // Never use this value outside of tests.
          ENCRYPTION_KEY: "I8nrTRRjuNtTIMGe1j5pyd5B1BekIrej5XbMrmSFFEI=",
        },
      },
    }),
  ],
});
