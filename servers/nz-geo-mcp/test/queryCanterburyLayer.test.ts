import { afterEach, describe, expect, it, vi } from "vitest";
import { queryCanterburyLayerHandler } from "../src/tools/queryCanterburyLayer.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("nz_geo_query_canterbury_layer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists sub-layers when layer_id is omitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          layers: [
            { id: 0, name: "Wells", geometryType: "esriGeometryPoint", type: "Feature Layer" },
            { id: 5, name: "Aquifers", geometryType: "esriGeometryPolygon", type: "Feature Layer" },
          ],
        }),
      ),
    );

    const result = await queryCanterburyLayerHandler({ service_path: "Public/Groundwater", service_type: "FeatureServer" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.layer_id).toBeNull();
    expect(result.structuredContent?.layers).toEqual([
      { layer_id: 0, name: "Wells", geometry_type: "esriGeometryPoint", layer_type: "Feature Layer" },
      { layer_id: 5, name: "Aquifers", geometry_type: "esriGeometryPolygon", layer_type: "Feature Layer" },
    ]);
  });

  it("queries a specific layer's features, paginating via limit/offset", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("returnCountOnly") === "true") return jsonResponse({ count: 42 });
      return jsonResponse({
        features: [{ attributes: { WELL_NO: "M36/0085", LOCALITY: "ROLLESTON" } }],
        exceededTransferLimit: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryCanterburyLayerHandler({
      service_path: "Public/Groundwater",
      service_type: "FeatureServer",
      layer_id: 0,
      limit: 1,
      offset: 0,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.items).toEqual([{ WELL_NO: "M36/0085", LOCALITY: "ROLLESTON" }]);
    expect(result.structuredContent?.total_count).toBe(42);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(1);
    expect(result.structuredContent?.notice).toContain("Showing 1 of 42");
  });

  it("surfaces an ArcGIS-level query error (HTTP 200 with an error body) as an actionable tool error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { code: 400, message: "Unable to complete operation.", details: ["Unable to perform query operation."] } }),
      ),
    );

    const result = await queryCanterburyLayerHandler({
      service_path: "Public/Groundwater",
      service_type: "FeatureServer",
      layer_id: 0,
      where: "garbage===",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unable to complete operation");
  });

  it("computes a centroid/bbox summary instead of returning raw geometry when include_geometry is true", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.searchParams.get("returnCountOnly") === "true") return jsonResponse({ count: 1 });
      return jsonResponse({
        features: [{ attributes: { LandID: "PRP-1" }, geometry: { rings: [[[172.0, -43.0], [172.1, -43.0], [172.1, -43.1], [172.0, -43.1]]] } }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryCanterburyLayerHandler({
      service_path: "Public/Canterbury_LandUnits",
      service_type: "FeatureServer",
      layer_id: 0,
      include_geometry: true,
    });

    const items = result.structuredContent?.items as Array<Record<string, unknown>>;
    expect(items[0]?.geometry_summary).toMatchObject({
      centroid: { lat: -43.05, lon: 172.05 },
      bbox: { min_lon: 172.0, min_lat: -43.1, max_lon: 172.1, max_lat: -43.0 },
    });
    expect(JSON.stringify(items[0])).not.toContain("rings");
  });
});
