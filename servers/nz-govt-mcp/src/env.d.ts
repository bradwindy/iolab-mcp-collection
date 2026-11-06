// This server needs no upstream API key — every tool is a pure function of its input plus the
// shared TTL cache. Bindings are hand-typed here rather than generated (see nz-culture-mcp's
// env.d.ts for the full rationale): this server has no wrangler.jsonc of its own anymore.
import type { CacheNamespace } from "@iolab/mcp-kit";

export {};

declare global {
  interface Env {
    /** TTL cache for slow-changing data.govt.nz CKAN responses. See CACHE_TTL in @iolab/mcp-kit. */
    MCP_CACHE: CacheNamespace;
    /**
     * Optional home proxy (shared with ia-mcp's Wayback calls). When both are set, data.govt.nz
     * CKAN calls go to `${WAYBACK_PROXY_URL}/__datagovt/...` with the key as `X-Wayback-Key`,
     * because data.govt.nz bot-blocks Cloudflare egress. Unset means direct.
     */
    WAYBACK_PROXY_URL?: string;
    WAYBACK_PROXY_KEY?: string;
  }
}
