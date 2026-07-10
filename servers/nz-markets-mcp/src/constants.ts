/** Must exactly match this server's wrangler.jsonc "name" field — it's the row key in the
 * shared credentials table and the path segment the portal uses to accept new key values. */
export const SERVER_SLUG = "nz-markets-mcp";

/** NZXplorer's `X-API-Key` header value. One key covers /companies, /companies/{ticker}, and
 * /announcements — NZXplorer scopes keys per account, not per endpoint. */
export const NZXPLORER_API_KEY = "NZXPLORER_API_KEY";

/** Electricity Authority subscription key for the "ICP connection data" product. Azure API
 * Management issues one subscription key per product, so this is DIFFERENT from
 * EA_DISPATCH_API_KEY even though both come from the same emi.developer.azure-api.net account. */
export const EA_ICP_API_KEY = "EA_ICP_API_KEY";

/** Electricity Authority subscription key for the "Wholesale market prices" product (which
 * gates the real-time dispatch API). See EA_ICP_API_KEY for why this is a separate key. */
export const EA_DISPATCH_API_KEY = "EA_DISPATCH_API_KEY";

export const PORTAL_URL = "https://mcp.iolab.nz";
