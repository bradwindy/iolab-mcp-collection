/** The credentials-table partition key — must exactly match apps/portal/src/manifest.ts's `slug`. */
export const SERVER_SLUG = "ia-mcp";

/** Optional archive.org S3-style access key — see src/credentials.ts for why these are optional. */
export const IA_S3_ACCESS_KEY = "IA_S3_ACCESS_KEY";
export const IA_S3_SECRET_KEY = "IA_S3_SECRET_KEY";
