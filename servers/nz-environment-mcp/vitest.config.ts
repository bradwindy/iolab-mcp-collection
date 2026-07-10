import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MCP_SHARED_TOKEN: "test-shared-token",
          PORTAL_URL: "https://mcp.example.com",
          // Valid base64-encoded 32-byte AES-256-GCM key, for tests only. Not used for any real data.
          ENCRYPTION_KEY: "PW8FuEhIc2nI3+L8+1ofwFtFD7LSYEpeAWNzYxxTtxc=",
        },
      },
    }),
  ],
});
