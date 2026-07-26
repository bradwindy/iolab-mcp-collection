/**
 * Static manifest of every server in the collection: its slug (the stable identifier — matches
 * the `server` column it reads/writes in the shared credentials table, and predates the
 * single-Worker gateway, so it is never renamed even though it no longer matches any
 * `wrangler.jsonc "name"`), its URL path prefix on the shared gateway hostname, and the upstream
 * API credentials it requires (if any).
 *
 * The portal renders this list on the dashboard, drives the per-server credential forms at
 * /admin/servers/:slug, and builds the `claude mcp add` examples on the Connect page.
 */

export type CredentialKeyDescriptor = {
  /** Env var name the target server reads the decrypted value as, e.g. "LINZ_API_KEY". */
  envName: string;
  /** Human-readable label shown on the credential form. */
  label: string;
  /** Where a user can sign up for this key. */
  signupUrl: string;
};

export type ServerManifestEntry = {
  /** Stable identifier: the `server` column in the shared credentials table. Never renamed. */
  slug: string;
  /**
   * URL path prefix on the gateway's single shared hostname (itself never committed to this repo
   * — read from the `BASE_DOMAIN` secret at request time). Must exactly match the `slug` this
   * server is registered under in `apps/gateway/src/servers.ts`. The server's MCP endpoint lives
   * at https://mcp.{BASE_DOMAIN}/{pathPrefix}/mcp.
   */
  pathPrefix: string;
  credentialKeys: CredentialKeyDescriptor[];
};

export const SERVERS: readonly ServerManifestEntry[] = [
  {
    slug: "nz-culture-mcp",
    pathPrefix: "nz-culture",
    credentialKeys: [
      {
        envName: "TE_PAPA_API_KEY",
        label: "Te Papa Collections API key",
        signupUrl: "https://data.tepapa.govt.nz/docs/register.html",
      },
    ],
  },
  {
    slug: "nz-stats-mcp",
    pathPrefix: "nz-stats",
    credentialKeys: [
      {
        envName: "STATS_NZ_SUBSCRIPTION_KEY",
        label: "Stats NZ API portal subscription key",
        signupUrl: "https://portal.apis.stats.govt.nz/how-to-subscribe",
      },
    ],
  },
  {
    slug: "nz-geo-mcp",
    pathPrefix: "nz-geo",
    credentialKeys: [
      {
        envName: "LINZ_API_KEY",
        label: "LINZ Data Service API key",
        signupUrl:
          "https://www.linz.govt.nz/guidance/data-service/linz-data-service-guide/web-services/creating-api-key",
      },
      {
        envName: "LINZ_BASEMAPS_API_KEY",
        label: "LINZ Basemaps API key",
        signupUrl: "https://basemaps.linz.govt.nz/docs/user-guide/_get-started/",
      },
    ],
  },
  {
    slug: "nz-environment-mcp",
    pathPrefix: "nz-environment",
    credentialKeys: [
      {
        envName: "NIWA_API_KEY",
        label: "NIWA developer portal API key (tides/UV/CO2)",
        signupUrl: "https://developer.niwa.co.nz/get-started",
      },
    ],
  },
  {
    slug: "nz-transport-mcp",
    pathPrefix: "nz-transport",
    credentialKeys: [
      {
        envName: "AT_SUBSCRIPTION_KEY",
        label: "Auckland Transport developer portal subscription key",
        signupUrl: "https://dev-portal.at.govt.nz/",
      },
    ],
  },
  {
    slug: "nz-markets-mcp",
    pathPrefix: "nz-markets",
    credentialKeys: [
      {
        envName: "NZXPLORER_API_KEY",
        label: "NZXplorer API key",
        signupUrl: "https://nzxplorer.co.nz/developers",
      },
      {
        envName: "EA_ICP_API_KEY",
        label: "Electricity Authority — ICP connection data subscription key",
        signupUrl: "https://emi.developer.azure-api.net/signup",
      },
      {
        envName: "EA_DISPATCH_API_KEY",
        label: "Electricity Authority — Wholesale market prices subscription key",
        signupUrl: "https://emi.developer.azure-api.net/signup",
      },
    ],
  },
  {
    slug: "nz-govt-mcp",
    pathPrefix: "nz-govt",
    credentialKeys: [],
  },
];

/** Look up one server's manifest entry by slug. Returns undefined for an unknown slug. */
export function findServer(slug: string): ServerManifestEntry | undefined {
  return SERVERS.find((server) => server.slug === slug);
}
