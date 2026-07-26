import type { McpServerRegistration } from "@iolab/mcp-kit";
import { NzCultureMcp } from "@iolab/nz-culture-mcp";
import { NzEnvironmentMcp } from "@iolab/nz-environment-mcp";
import { NzGeoMcp } from "@iolab/nz-geo-mcp";
import { NzGovtMcp } from "@iolab/nz-govt-mcp";
import { NzMarketsMcp } from "@iolab/nz-markets-mcp";
import { NzStatsMcp } from "@iolab/nz-stats-mcp";
import { NzTransportMcp } from "@iolab/nz-transport-mcp";

// Re-exported so src/index.ts can name every Durable Object class as a top-level export — required
// by wrangler.jsonc's durable_objects.bindings[].class_name, which must resolve against the
// Worker's `main` module directly.
export { NzCultureMcp, NzEnvironmentMcp, NzGeoMcp, NzGovtMcp, NzMarketsMcp, NzStatsMcp, NzTransportMcp };

/**
 * The gateway's server registry: URL slug (→ `/{slug}/mcp`) to agent class and Durable Object
 * binding name. `slug` here must exactly match the corresponding manifest entry's `pathPrefix` in
 * apps/portal/src/manifest.ts — one is what the gateway actually routes, the other is what the
 * portal displays; a mismatch means the Connect page renders a URL the gateway doesn't serve.
 *
 * InternetArchiveMcp / IA_MCP is added here once Part 2 of the gateway plan builds it.
 */
export const SERVERS: readonly McpServerRegistration<Env>[] = [
  { slug: "nz-culture", agent: NzCultureMcp, binding: "NZ_CULTURE_MCP" },
  { slug: "nz-environment", agent: NzEnvironmentMcp, binding: "NZ_ENVIRONMENT_MCP" },
  { slug: "nz-geo", agent: NzGeoMcp, binding: "NZ_GEO_MCP" },
  { slug: "nz-govt", agent: NzGovtMcp, binding: "NZ_GOVT_MCP" },
  { slug: "nz-markets", agent: NzMarketsMcp, binding: "NZ_MARKETS_MCP" },
  { slug: "nz-stats", agent: NzStatsMcp, binding: "NZ_STATS_MCP" },
  { slug: "nz-transport", agent: NzTransportMcp, binding: "NZ_TRANSPORT_MCP" },
];
