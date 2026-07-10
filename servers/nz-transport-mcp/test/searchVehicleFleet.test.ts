import { afterEach, describe, expect, it, vi } from "vitest";
import { searchVehicleFleetHandler } from "../src/tools/searchVehicleFleet.js";

const SAMPLE_ROW = {
  OBJECTID: 2,
  MAKE: "KAWASAKI",
  MODEL: "KL",
  SUBMODEL: "650A",
  BODY_TYPE: "MOTORCYCLE",
  VEHICLE_TYPE: "MOTORCYCLE",
  VEHICLE_USAGE: "PRIVATE PASSENGER",
  CLASS: "LC",
  MOTIVE_POWER: "PETROL",
  ALTERNATIVE_MOTIVE_POWER: null,
  BASIC_COLOUR: "BLACK",
  CC_RATING: 651,
  POWER_RATING: 35,
  GROSS_VEHICLE_MASS: 0,
  VDAM_WEIGHT: 0,
  NUMBER_OF_SEATS: 0,
  NUMBER_OF_AXLES: 0,
  FIRST_NZ_REGISTRATION_YEAR: 2006,
  FIRST_NZ_REGISTRATION_MONTH: 11,
  VEHICLE_YEAR: 2006,
  IMPORT_STATUS: "NEW",
  NZ_ASSEMBLED: "IMPORTED BUILT-UP",
  ORIGINAL_COUNTRY: "JAPAN",
  PREVIOUS_COUNTRY: "NONE",
  TLA: "LOWER HUTT CITY",
  POSTCODE: 5014,
  TRANSMISSION_TYPE: null,
  ROAD_TRANSPORT_CODE: null,
  INDUSTRY_CLASS: "PRIVATE",
  VIN11: "JKAKLEA167D",
  CHASSIS7: null,
  ENGINE_NUMBER: "A31497",
  SYNTHETIC_GREENHOUSE_GAS: null,
  FC_COMBINED: null,
  FC_URBAN: null,
  FC_EXTRA_URBAN: null,
};

function arcgisMock(rows: unknown[], count: number) {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(input.toString());
    if (url.searchParams.get("returnCountOnly") === "true") {
      return new Response(JSON.stringify({ count }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ features: rows.map((attributes) => ({ attributes })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("nz_transport_search_vehicle_fleet", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("errors when no filter is provided", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchVehicleFleetHandler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("make");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns concise rows for a make filter", async () => {
    vi.stubGlobal("fetch", arcgisMock([SAMPLE_ROW], 1));

    const result = await searchVehicleFleetHandler({ make: "Kawasaki" });

    expect(result.structuredContent?.items).toEqual([
      {
        make: "KAWASAKI",
        model: "KL",
        vehicle_type: "MOTORCYCLE",
        fuel_type: "PETROL",
        vehicle_year: 2006,
        territorial_authority: "LOWER HUTT CITY",
      },
    ]);
  });

  it("includes the truncated VIN and fuel consumption block in detailed format", async () => {
    vi.stubGlobal("fetch", arcgisMock([SAMPLE_ROW], 1));

    const result = await searchVehicleFleetHandler({ make: "Kawasaki", response_format: "detailed" });

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.vin_truncated).toBe("JKAKLEA167D");
    expect(item?.first_nz_registration).toBe("2006-11");
    expect(item?.fuel_consumption_l_per_100km).toEqual({ combined: null, urban: null, extra_urban: null });
  });

  it("builds a case-insensitive where clause for make, fuel_type, and territorial_authority", async () => {
    const fetchMock = arcgisMock([SAMPLE_ROW], 1);
    vi.stubGlobal("fetch", fetchMock);

    await searchVehicleFleetHandler({ make: "Tesla", fuel_type: "electric", territorial_authority: "auckland" });

    const where = new URL(fetchMock.mock.calls[0]?.[0] as string).searchParams.get("where") ?? "";
    expect(where).toContain("UPPER(MAKE) LIKE UPPER('%Tesla%')");
    expect(where).toContain("UPPER(MOTIVE_POWER) LIKE UPPER('%electric%')");
    expect(where).toContain("UPPER(TLA) LIKE UPPER('%auckland%')");
  });

  it("reports pagination truncation via the notice field", async () => {
    vi.stubGlobal("fetch", arcgisMock([SAMPLE_ROW], 22637));

    const result = await searchVehicleFleetHandler({ make: "Tesla", limit: 1 });

    expect(result.structuredContent?.notice).toContain("Showing 1 of 22637");
  });

  it("returns an actionable error when ArcGIS reports a query error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: { code: 400, message: "Invalid query parameters." } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await searchVehicleFleetHandler({ make: "Tesla" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid query parameters.");
  });
});
