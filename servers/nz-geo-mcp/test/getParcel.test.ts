import { afterEach, describe, expect, it, vi } from "vitest";
import { getParcelHandler } from "../src/tools/getParcel.js";
import { buildFakeEnv } from "./fixtures.js";

const SAMPLE_RESPONSE = {
  vectorQuery: {
    layers: {
      "50772": {
        name: "NZ Primary Parcels",
        features: [
          {
            properties: {
              id: 1234567,
              appellation: "Lot 1 DP 12345",
              parcel_intent: "Fee Simple Title",
              land_district: "Canterbury",
              survey_area: 8025.4,
              titles: ["CB1A/123"],
              affected_surveys: ["DP 12345"],
              statutory_actions: [],
              topology_type: "Primary",
            },
            geometry: { type: "Point", coordinates: [172.6362, -43.5321] },
          },
        ],
      },
    },
  },
};

function vectorQueryResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("nz_geo_get_parcel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when LINZ_API_KEY is not configured", async () => {
    const { env } = await buildFakeEnv();
    const result = await getParcelHandler({ lat: -43.5321, lon: 172.6362 }, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("LINZ_API_KEY");
  });

  it("returns concise parcel fields by default, including area in hectares", async () => {
    const { env } = await buildFakeEnv({ LINZ_API_KEY: "test-linz-key" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(vectorQueryResponse(SAMPLE_RESPONSE)));

    const result = await getParcelHandler({ lat: -43.5321, lon: 172.6362 }, env);

    expect(result.isError).toBeUndefined();
    const parcels = result.structuredContent?.parcels as Array<Record<string, unknown>>;
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({
      linz_parcel_id: 1234567,
      appellation: "Lot 1 DP 12345",
      parcel_intent: "Fee Simple Title",
      land_district: "Canterbury",
      num_titles: 1,
    });
    expect(parcels[0]?.area_ha).toBeCloseTo(0.80254);
    expect(parcels[0]?.titles).toBeUndefined();
  });

  it("includes titles/surveys/bbox in detailed format", async () => {
    const { env } = await buildFakeEnv({ LINZ_API_KEY: "test-linz-key" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(vectorQueryResponse(SAMPLE_RESPONSE)));

    const result = await getParcelHandler({ lat: -43.5321, lon: 172.6362, response_format: "detailed" }, env);

    const parcels = result.structuredContent?.parcels as Array<Record<string, unknown>>;
    expect(parcels[0]?.titles).toEqual(["CB1A/123"]);
    expect(parcels[0]?.bbox).toBeDefined();
  });

  it("returns a helpful notice when no parcel is found nearby", async () => {
    const { env } = await buildFakeEnv({ LINZ_API_KEY: "test-linz-key" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        vectorQueryResponse({ vectorQuery: { layers: { "50772": { name: "NZ Primary Parcels", features: [] } } } }),
      ),
    );

    const result = await getParcelHandler({ lat: 0, lon: 0 }, env);

    expect(result.structuredContent?.count).toBe(0);
    expect(result.structuredContent?.notice).toContain("No parcels found");
  });
});
