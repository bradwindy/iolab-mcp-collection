// Must exactly match the "name" field in wrangler.jsonc — @nz-mcp/credentials scopes
// stored keys by this server slug.
export const SERVER_SLUG = "nz-environment-mcp";


// NIWA's developer portal ("developer.niwa.co.nz") issues one API key per registered
// "app", and that single app can be subscribed to multiple API products (Tide, UV,
// CO2, SolarView, FPAT all appear as separate products under the one portal site).
// We could not fetch the portal's own docs text to confirm this in so many words (it's
// a client-rendered SPA that resists automated fetching), but every NIWA catalog entry
// uses identical signup wording ("register an app name and generate an API key") and the
// portal's backend product catalogue lists all NIWA APIs under one site/account. We treat
// this as one shared credential; see README.md for the caveat.
export const NIWA_API_KEY_NAME = "NIWA_API_KEY";
