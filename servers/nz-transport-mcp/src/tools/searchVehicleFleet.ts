import { z } from "zod";
import {
  attribution,
  describePage,
  jsonResult,
  limitParam,
  offsetParam,
  responseFormatParam,
  selectFormat,
  toolError,
  truncationNotice,
  type ToolTextResult,
} from "@iolab/mcp-kit";
import { ArcgisQueryError } from "../clients/arcgisFeatureServer.js";
import { queryVehicleFleet, SOURCE, type MvrVehicleRow } from "../clients/motorVehicleRegister.js";

const MAX_LIMIT = 200;

export const searchVehicleFleetInputShape = {
  make: z.string().min(1).max(60).optional().describe("Free-text, case-insensitive match against the vehicle make, e.g. 'Toyota'."),
  fuel_type: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe(
      "Free-text, case-insensitive match against the motive power type, e.g. 'PETROL', 'DIESEL', 'ELECTRIC', 'PETROL HYBRID'.",
    ),
  territorial_authority: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("Free-text, case-insensitive match against the owner's territorial authority (TLA), e.g. 'Auckland'."),
  limit: limitParam(MAX_LIMIT, 50),
  offset: offsetParam,
  response_format: responseFormatParam,
};

export const searchVehicleFleetOutputShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  total_count: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().nullable(),
  notice: z.string(),
  attribution: z.object({ source: z.string(), url: z.string().optional() }),
};

const inputSchema = z.object(searchVehicleFleetInputShape);

function toConcise(row: MvrVehicleRow) {
  return {
    make: row.MAKE,
    model: row.MODEL,
    vehicle_type: row.VEHICLE_TYPE,
    fuel_type: row.MOTIVE_POWER,
    vehicle_year: row.VEHICLE_YEAR,
    territorial_authority: row.TLA,
  };
}

function toDetailed(row: MvrVehicleRow) {
  return {
    ...toConcise(row),
    submodel: row.SUBMODEL,
    body_type: row.BODY_TYPE,
    vehicle_usage: row.VEHICLE_USAGE,
    class: row.CLASS,
    alternative_motive_power: row.ALTERNATIVE_MOTIVE_POWER,
    colour: row.BASIC_COLOUR,
    cc_rating: row.CC_RATING,
    power_rating_kw: row.POWER_RATING,
    gross_vehicle_mass_kg: row.GROSS_VEHICLE_MASS,
    number_of_seats: row.NUMBER_OF_SEATS,
    number_of_axles: row.NUMBER_OF_AXLES,
    first_nz_registration: row.FIRST_NZ_REGISTRATION_YEAR
      ? `${row.FIRST_NZ_REGISTRATION_YEAR}-${String(row.FIRST_NZ_REGISTRATION_MONTH ?? 1).padStart(2, "0")}`
      : null,
    import_status: row.IMPORT_STATUS,
    nz_assembled: row.NZ_ASSEMBLED,
    original_country: row.ORIGINAL_COUNTRY,
    postcode: row.POSTCODE,
    fuel_consumption_l_per_100km: {
      combined: row.FC_COMBINED,
      urban: row.FC_URBAN,
      extra_urban: row.FC_EXTRA_URBAN,
    },
    // Deliberately truncated by NZTA to protect vehicle/owner identity — see tool description.
    vin_truncated: row.VIN11,
  };
}

export async function searchVehicleFleetHandler(rawInput: unknown): Promise<ToolTextResult> {
  const input = inputSchema.parse(rawInput);

  if (!input.make && !input.fuel_type && !input.territorial_authority) {
    return toolError(
      "Provide at least one of `make`, `fuel_type`, or `territorial_authority`.",
      "Searching with none of these would page through NZ's ~5.9 million registered vehicles unfiltered.",
    );
  }

  try {
    const { rows, totalCount } = await queryVehicleFleet({
      ...(input.make ? { make: input.make } : {}),
      ...(input.fuel_type ? { fuelType: input.fuel_type } : {}),
      ...(input.territorial_authority ? { territorialAuthority: input.territorial_authority } : {}),
      limit: input.limit,
      offset: input.offset,
    });

    const page = describePage({ returned: rows.length, total_count: totalCount, offset: input.offset });
    const items = rows.map((row) => selectFormat(input.response_format, toConcise(row), toDetailed(row)));

    return jsonResult({
      items,
      ...page,
      notice: truncationNotice(
        input.offset + rows.length,
        totalCount,
        "Narrow with `make`, `fuel_type`, or `territorial_authority`.",
      ),
      attribution: attribution(SOURCE, {
        url: "https://opendata-nzta.opendata.arcgis.com/datasets/NZTA::motor-vehicle-register-api",
      }),
    });
  } catch (error) {
    if (error instanceof ArcgisQueryError) {
      return toolError(error.message, "This may indicate an unexpected upstream schema change; please report it.");
    }
    throw error;
  }
}
