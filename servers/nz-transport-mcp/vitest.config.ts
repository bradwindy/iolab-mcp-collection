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
    }),
  ],
});
