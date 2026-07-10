import { afterEach, describe, expect, it, vi } from "vitest";
import { getLicenceHolderStatsHandler } from "../src/tools/getLicenceHolderStats.js";
import { makeTestEnv } from "./helpers/env.js";

const ROWS = [
  {
    OBJECTID: 1,
    region: "Auckland Region",
    licenceClass: "Motor Cars And Light Motor Vehicles",
    licenceStage: "Full",
    ageGroup: "24 or less",
    licenceCount: 67466,
    financialYear: "24/25",
  },
  {
    OBJECTID: 2,
    region: "Auckland Region",
    licenceClass: "Motor Cars And Light Motor Vehicles",
    licenceStage: "Full",
    ageGroup: "25-29",
    licenceCount: 98137,
    financialYear: "24/25",
  },
  {
    OBJECTID: 3,
    region: "Otago Region",
    licenceClass: "Motorcycle",
    licenceStage: "Full",
    ageGroup: "24 or less",
    licenceCount: 500,
    financialYear: "23/24",
  },
];

function arcgisRowsResponse() {
  // Fewer rows than the layer's page size (2000), so the client's fetch-all loop stops after one call.
  return new Response(JSON.stringify({ features: ROWS.map((attributes) => ({ attributes })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("nz_transport_get_licence_holder_stats", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns all rows, unfiltered, in the confirmed field shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(arcgisRowsResponse()));
    const env = await makeTestEnv();

    const result = await getLicenceHolderStatsHandler({}, env);

    expect(result.structuredContent?.total_count).toBe(3);
    expect(result.structuredContent?.items).toContainEqual({
      region: "Auckland Region",
      licence_class: "Motor Cars And Light Motor Vehicles",
      licence_stage: "Full",
      age_group: "24 or less",
      financial_year: "24/25",
      licence_count: 67466,
    });
  });

  it("filters by region case-insensitively", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(arcgisRowsResponse()));
    const env = await makeTestEnv();

    const result = await getLicenceHolderStatsHandler({ region: "auckland" }, env);

    expect(result.structuredContent?.total_count).toBe(2);
  });

  it("filters by licence_class, age_group, and financial_year", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(arcgisRowsResponse()));
    const env = await makeTestEnv();

    const result = await getLicenceHolderStatsHandler(
      { licence_class: "motorcycle", age_group: "24 or less", financial_year: "23/24" },
      env,
    );

    expect(result.structuredContent?.total_count).toBe(1);
    const items = result.structuredContent?.items as Array<Record<string, unknown>>;
    expect(items[0]?.region).toBe("Otago Region");
  });

  it("caches the full dataset across repeated calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(arcgisRowsResponse());
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv();

    await getLicenceHolderStatsHandler({}, env);
    await getLicenceHolderStatsHandler({ region: "otago" }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports pagination truncation via the notice field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(arcgisRowsResponse()));
    const env = await makeTestEnv();

    const result = await getLicenceHolderStatsHandler({ limit: 1 }, env);

    expect(result.structuredContent?.notice).toContain("Showing 1 of 3");
  });

  it("returns an actionable error when ArcGIS reports a query error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 400, message: "Invalid query parameters." } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const env = await makeTestEnv();

    const result = await getLicenceHolderStatsHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid query parameters.");
  });
});
