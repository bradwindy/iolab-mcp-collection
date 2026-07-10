import { arcgisContains, countArcgisFeatures, queryArcgisFeatures } from "./arcgisFeatureServer.js";

// The catalog's documented service name (MVR_May21) is stale; the live service directory
// (curl 'https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services?f=json') lists it as
// MVR_Mar26 instead — NZTA renames this service to match each monthly refresh. Confirmed live:
// curl 'https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/MVR_Mar26/FeatureServer/0/query?where=1%3D1&outFields=*&f=json&resultRecordCount=2'
const BASE_URL = "https://services.arcgis.com/CXBb7LAjgIIdcsPt/arcgis/rest/services/MVR_Mar26/FeatureServer/0";
export const SOURCE = "NZTA Motor Vehicle Register";

export type MvrVehicleRow = {
  OBJECTID: number;
  MAKE: string | null;
  MODEL: string | null;
  SUBMODEL: string | null;
  BODY_TYPE: string | null;
  VEHICLE_TYPE: string | null;
  VEHICLE_USAGE: string | null;
  CLASS: string | null;
  MOTIVE_POWER: string | null;
  ALTERNATIVE_MOTIVE_POWER: string | null;
  BASIC_COLOUR: string | null;
  CC_RATING: number | null;
  POWER_RATING: number | null;
  GROSS_VEHICLE_MASS: number | null;
  VDAM_WEIGHT: number | null;
  NUMBER_OF_SEATS: number | null;
  NUMBER_OF_AXLES: number | null;
  FIRST_NZ_REGISTRATION_YEAR: number | null;
  FIRST_NZ_REGISTRATION_MONTH: number | null;
  VEHICLE_YEAR: number | null;
  IMPORT_STATUS: string | null;
  NZ_ASSEMBLED: string | null;
  ORIGINAL_COUNTRY: string | null;
  PREVIOUS_COUNTRY: string | null;
  /** Territorial authority of the registered owner — the "privacy-protected owner geography" field. */
  TLA: string | null;
  POSTCODE: number | null;
  TRANSMISSION_TYPE: string | null;
  ROAD_TRANSPORT_CODE: string | null;
  INDUSTRY_CLASS: string | null;
  /** Deliberately truncated by NZTA (first 11 characters only) to protect vehicle identity. */
  VIN11: string | null;
  CHASSIS7: string | null;
  ENGINE_NUMBER: string | null;
  SYNTHETIC_GREENHOUSE_GAS: string | null;
  FC_COMBINED: string | null;
  FC_URBAN: string | null;
  FC_EXTRA_URBAN: string | null;
};

export type VehicleFleetQuery = {
  make?: string;
  fuelType?: string;
  territorialAuthority?: string;
  limit: number;
  offset: number;
};

function buildWhere(q: VehicleFleetQuery): string {
  const clauses: string[] = [];
  if (q.make) clauses.push(arcgisContains("MAKE", q.make));
  if (q.fuelType) clauses.push(arcgisContains("MOTIVE_POWER", q.fuelType));
  if (q.territorialAuthority) clauses.push(arcgisContains("TLA", q.territorialAuthority));
  return clauses.length > 0 ? clauses.join(" AND ") : "1=1";
}

export async function queryVehicleFleet(
  q: VehicleFleetQuery,
): Promise<{ rows: MvrVehicleRow[]; totalCount: number }> {
  const where = buildWhere(q);
  const [totalCount, rows] = await Promise.all([
    countArcgisFeatures(SOURCE, BASE_URL, where),
    queryArcgisFeatures<MvrVehicleRow>(SOURCE, BASE_URL, {
      where,
      // No natural recency field in a point-in-time snapshot; OBJECTID gives stable pagination order.
      orderByFields: "OBJECTID",
      resultOffset: q.offset,
      resultRecordCount: q.limit,
    }),
  ]);
  return { rows, totalCount };
}
