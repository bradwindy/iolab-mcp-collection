import { afterEach, describe, expect, it, vi } from "vitest";
import { searchCanterburyServicesHandler } from "../src/tools/searchCanterburyServices.js";
import { buildFakeEnv } from "./fixtures.js";

function directoryResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function stubDirectory() {
  return vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://gis.ecan.govt.nz/arcgis/rest/services/Public?")) {
      return directoryResponse({
        folders: [],
        services: [
          { name: "Public/Groundwater", type: "FeatureServer" },
          { name: "Public/Groundwater", type: "MapServer" },
        ],
      });
    }
    if (url.startsWith("https://gis.ecan.govt.nz/arcgis/rest/services?")) {
      return directoryResponse({ folders: ["Public"], services: [{ name: "Region_Base", type: "MapServer" }] });
    }
    throw new Error(`unexpected URL in test: ${url}`);
  });
}

describe("nz_geo_search_canterbury_services", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("finds services matching a keyword, concise by default", async () => {
    const { env } = await buildFakeEnv();
    vi.stubGlobal("fetch", stubDirectory());

    const result = await searchCanterburyServicesHandler({ query: "groundwater" }, env);

    expect(result.isError).toBeUndefined();
    const items = result.structuredContent?.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ service_path: "Public/Groundwater", type: "FeatureServer" });
    expect(result.structuredContent?.total_count).toBe(2);
  });

  it("includes rest_url and queryable/geocoder flags in detailed format", async () => {
    const { env } = await buildFakeEnv();
    vi.stubGlobal("fetch", stubDirectory());

    const result = await searchCanterburyServicesHandler({ query: "groundwater", response_format: "detailed" }, env);

    const items = result.structuredContent?.items as Array<Record<string, unknown>>;
    expect(items[0]?.rest_url).toBe("https://gis.ecan.govt.nz/arcgis/rest/services/Public/Groundwater/FeatureServer");
    expect(items[0]?.queryable).toBe(true);
    expect(items[0]?.geocoder).toBe(false);
  });

  it("caches the crawled directory so a second search doesn't re-fetch it", async () => {
    const { env } = await buildFakeEnv();
    const fetchMock = stubDirectory();
    vi.stubGlobal("fetch", fetchMock);

    await searchCanterburyServicesHandler({ query: "groundwater" }, env);
    const callsAfterFirst = fetchMock.mock.calls.length;
    await searchCanterburyServicesHandler({ query: "region" }, env);

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("returns an empty page with no error when nothing matches", async () => {
    const { env } = await buildFakeEnv();
    vi.stubGlobal("fetch", stubDirectory());

    const result = await searchCanterburyServicesHandler({ query: "nonexistent-topic-xyz" }, env);

    expect(result.structuredContent?.items).toEqual([]);
    expect(result.structuredContent?.total_count).toBe(0);
  });
});
