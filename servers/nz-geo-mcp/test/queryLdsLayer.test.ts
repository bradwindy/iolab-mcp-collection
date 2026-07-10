import { afterEach, describe, expect, it, vi } from "vitest";
import { queryLdsLayerHandler } from "../src/tools/queryLdsLayer.js";
import { buildFakeEnv } from "./fixtures.js";

function vectorQueryResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

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
            },
            geometry: { type: "Point", coordinates: [172.6362, -43.5321] },
          },
        ],
      },
    },
  },
};

describe("nz_geo_query_layer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when LINZ_API_KEY is not configured", async () => {
    const { env } = await buildFakeEnv();
    const result = await queryLdsLayerHandler({ layer_ids: [50772], lat: -43.5, lon: 172.6 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("LINZ_API_KEY");
  });

  it("queries the configured layer(s) and returns feature properties", async () => {
    const { env } = await buildFakeEnv({ LINZ_API_KEY: "test-linz-key" });
    const fetchMock = vi.fn().mockResolvedValue(vectorQueryResponse(SAMPLE_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryLdsLayerHandler({ layer_ids: [50772], lat: -43.5, lon: 172.6 }, env);

    expect(result.isError).toBeUndefined();
    const layers = result.structuredContent?.layers as Array<Record<string, unknown>>;
    expect(layers).toHaveLength(1);
    expect(layers[0]?.layer_name).toBe("NZ Primary Parcels");
    const features = layers[0]?.features as Array<Record<string, unknown>>;
    expect(features[0]?.appellation).toBe("Lot 1 DP 12345");
    expect(features[0]?.geometry_summary).toBeUndefined();

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("key")).toBe("test-linz-key");
    expect(requestedUrl.searchParams.getAll("layer")).toEqual(["50772"]);
  });

  it("includes a centroid/bbox geometry summary when include_geometry is true, never raw coordinates", async () => {
    const { env } = await buildFakeEnv({ LINZ_API_KEY: "test-linz-key" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(vectorQueryResponse(SAMPLE_RESPONSE)));

    const result = await queryLdsLayerHandler(
      { layer_ids: [50772], lat: -43.5, lon: 172.6, include_geometry: true },
      env,
    );

    const layers = result.structuredContent?.layers as Array<Record<string, unknown>>;
    const features = layers[0]?.features as Array<Record<string, unknown>>;
    const summary = features[0]?.geometry_summary as { centroid: { lat: number; lon: number } };
    expect(summary.centroid.lat).toBeCloseTo(-43.5321);
    expect(summary.centroid.lon).toBeCloseTo(172.6362);
    expect(JSON.stringify(features[0])).not.toContain("coordinates");
  });

  it("surfaces an upstream HTTP failure as an actionable tool error", async () => {
    const { env } = await buildFakeEnv({ LINZ_API_KEY: "bad-key" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("invalid-api-key: Provide a valid api key", { status: 403 })),
    );

    const result = await queryLdsLayerHandler({ layer_ids: [50772], lat: -43.5, lon: 172.6 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("LINZ Data Service");
  });
});
