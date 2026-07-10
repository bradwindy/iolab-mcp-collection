import { afterEach, describe, expect, it, vi } from "vitest";
import { searchQuakesHandler } from "../src/tools/searchQuakes.js";
import { createFakeEnv } from "./testEnv.js";

function quakeFeature(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [174.128356934, -41.694587708] },
    properties: {
      publicID: "2026p513076",
      time: "2026-07-09T20:07:09.468Z",
      depth: 5,
      magnitude: 2.47,
      mmi: 3,
      locality: "5 km south-east of Seddon",
      quality: "best",
      ...overrides,
    },
  };
}

function quakeResponse(features: unknown[]) {
  return new Response(JSON.stringify({ type: "FeatureCollection", features }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("nz_env_search_quakes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns concise results by default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(quakeResponse([quakeFeature()])));
    const env = await createFakeEnv();

    const result = await searchQuakesHandler({}, env);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.items).toEqual([
      {
        public_id: "2026p513076",
        time: "2026-07-09T20:07:09.468Z",
        magnitude: 2.5,
        depth_km: 5,
        mmi: 3,
        locality: "5 km south-east of Seddon",
        quality: "best",
      },
    ]);
    expect(result.structuredContent?.total_count).toBe(1);
    expect(result.structuredContent?.has_more).toBe(false);
  });

  it("includes coordinates in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(quakeResponse([quakeFeature()])));
    const env = await createFakeEnv();

    const result = await searchQuakesHandler({ response_format: "detailed" }, env);
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.longitude).toBeCloseTo(174.128356934);
    expect(item?.latitude).toBeCloseTo(-41.694587708);
  });

  it("requests the given MMI threshold", async () => {
    const fetchMock = vi.fn().mockResolvedValue(quakeResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv();

    await searchQuakesHandler({ min_mmi: 5 }, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("MMI")).toBe("5");
  });

  it("filters out deleted quakes by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        quakeResponse([quakeFeature({ publicID: "a", quality: "best" }), quakeFeature({ publicID: "b", quality: "deleted" })]),
      ),
    );
    const env = await createFakeEnv();

    const result = await searchQuakesHandler({}, env);

    expect(result.structuredContent?.total_count).toBe(1);
  });

  it("applies a client-side min_magnitude filter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        quakeResponse([quakeFeature({ publicID: "small", magnitude: 2.1 }), quakeFeature({ publicID: "big", magnitude: 5.4 })]),
      ),
    );
    const env = await createFakeEnv();

    const result = await searchQuakesHandler({ min_magnitude: 5 }, env);
    const items = result.structuredContent?.items as Array<Record<string, unknown>>;

    expect(items).toHaveLength(1);
    expect(items[0]?.public_id).toBe("big");
  });

  it("reports pagination truncation via the notice field", async () => {
    const features = Array.from({ length: 5 }, (_, i) => quakeFeature({ publicID: `q${i}` }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(quakeResponse(features)));
    const env = await createFakeEnv();

    const result = await searchQuakesHandler({ limit: 2 }, env);

    expect(result.structuredContent?.notice).toContain("Showing 2 of 5");
    expect(result.structuredContent?.next_offset).toBe(2);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));
    const env = await createFakeEnv();

    const result = await searchQuakesHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("GeoNet API returned HTTP 503");
  });
});
