import { afterEach, describe, expect, it, vi } from "vitest";
import { searchAucklandOpenDataHandler } from "../src/tools/searchAucklandOpenData.js";

function featureCollection(features: unknown[], numberMatched: number) {
  return new Response(JSON.stringify({ features, numberMatched, numberReturned: features.length }), {
    status: 200,
    headers: { "content-type": "application/geo+json" },
  });
}

const SAMPLE_FEATURE = {
  id: "9aa8b3a4f58f4e1cb3fe1515a3aff301",
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [[[174.7, -36.8]]] },
  properties: {
    title: "Parking Variation Control",
    type: "Feature Service",
    snippet: "Parking Variation Control, Auckland Unitary Plan",
    tags: ["Unitary Plan"],
    owner: "OpenDataUser",
    modified: 1783086792000,
    url: "https://services1.arcgis.com/n4yPwebTjJCmXB6W/arcgis/rest/services/Parking_Variation_Control/FeatureServer",
    license: null,
  },
};

describe("nz_govt_search_auckland_open_data", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops the raw geometry/extent and returns clean summaries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(featureCollection([SAMPLE_FEATURE], 3)));

    const result = await searchAucklandOpenDataHandler({ query: "transport" });

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item).not.toHaveProperty("geometry");
    expect(item).not.toHaveProperty("extent");
    expect(item?.title).toBe("Parking Variation Control");
    expect(item?.service_url).toContain("FeatureServer");
    expect(result.structuredContent?.total_count).toBe(3);
    expect(result.structuredContent?.has_more).toBe(true);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 502, statusText: "Bad Gateway" })));

    const result = await searchAucklandOpenDataHandler({ query: "transport" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Auckland Council Open Data returned HTTP 502");
  });
});
