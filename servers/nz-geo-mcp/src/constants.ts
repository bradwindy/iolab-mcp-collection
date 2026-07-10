export const PORTAL_URL = "https://mcp.example.invalid";

/** Must exactly match wrangler.jsonc's top-level "name" — the credential store's partition key. */
export const SERVER_SLUG = "nz-geo-mcp";

/**
 * LINZ Data Service layer id for "NZ Primary Parcels" (2.7M polygons: current primary parcel
 * boundaries with appellation/legal description, parcel intent, land district, and title links).
 * Confirmed via https://data.linz.govt.nz/layer/50772-nz-primary-parcels/ — this is also the
 * exact layer id used in LINZ's own documented sample request for the vector query API.
 */
export const LINZ_PRIMARY_PARCELS_LAYER_ID = 50772;
