/**
 * Static manifest of every server in the nz-mcp-collection: its slug (matches the server's
 * wrangler.jsonc "name" AND the `server` column it reads/writes in the shared credentials
 * table), its public MCP subdomain, and the upstream API credentials it requires (if any).
 *
 * The portal renders this list on the dashboard, drives the per-server credential forms at
 * /servers/:slug, and builds the `claude mcp add` examples on the Connect page.
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
  /** Matches the server's wrangler.jsonc "name" and the `server` column in the shared credentials table. */
  slug: string;
  /** Public hostname the deployed MCP server answers on (its /mcp endpoint lives at https://{subdomain}/mcp). */
  subdomain: string;
  credentialKeys: CredentialKeyDescriptor[];
};

export const SERVERS: readonly ServerManifestEntry[] = [
  {
    slug: "nz-culture-mcp",
    subdomain: "nz-culture.mcp.iolab.nz",
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
    subdomain: "nz-stats.mcp.iolab.nz",
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
    subdomain: "nz-geo.mcp.iolab.nz",
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
    subdomain: "nz-environment.mcp.iolab.nz",
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
    subdomain: "nz-transport.mcp.iolab.nz",
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
    subdomain: "nz-markets.mcp.iolab.nz",
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
    subdomain: "nz-govt.mcp.iolab.nz",
    credentialKeys: [],
  },
];

/** Look up one server's manifest entry by slug. Returns undefined for an unknown slug. */
export function findServer(slug: string): ServerManifestEntry | undefined {
  return SERVERS.find((server) => server.slug === slug);
}
