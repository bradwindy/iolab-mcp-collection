import { afterEach, describe, expect, it, vi } from "vitest";
import { getShakingIntensityHandler } from "../src/tools/getShakingIntensity.js";
import { createFakeEnv } from "./testEnv.js";

function intensityFeature(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [174.984741211, -40.893859863] },
    properties: { mmi: 3, count: 1, count_mmi: { "3": 1 }, ...overrides },
  };
}

function intensityResponse(features: unknown[], top: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ type: "FeatureCollection", features, count: features.length, count_mmi: {}, ...top }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("nz_env_get_shaking_intensity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects public_id combined with type='measured'", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv();

    const result = await getShakingIntensityHandler({ type: "measured", public_id: "2026p507720" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("only valid with type='reported'");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns concise points and the network-wide summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(intensityResponse([intensityFeature()], { count: 42, count_mmi: { "3": 42 } })),
    );
    const env = await createFakeEnv();

    const result = await getShakingIntensityHandler({ type: "measured" }, env);

    expect(result.structuredContent?.summary).toEqual({ count: 42, count_by_mmi: { "3": 42 } });
    const points = result.structuredContent?.points as Array<Record<string, unknown>>;
    expect(points[0]?.mmi).toBe(3);
    expect(points[0]?.count).toBeUndefined();
  });

  it("includes per-point counts in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(intensityResponse([intensityFeature()])));
    const env = await createFakeEnv();

    const result = await getShakingIntensityHandler({ type: "reported", public_id: "2026p507720", response_format: "detailed" }, env);
    const point = (result.structuredContent?.points as Array<Record<string, unknown>>)[0];

    expect(point?.count).toBe(1);
    expect(point?.count_by_mmi).toEqual({ "3": 1 });
  });

  it("passes type, aggregation, and publicID through to the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(intensityResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv();

    await getShakingIntensityHandler({ type: "reported", aggregation: "median", public_id: "2026p507720" }, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("type")).toBe("reported");
    expect(requestedUrl.searchParams.get("aggregation")).toBe("median");
    expect(requestedUrl.searchParams.get("publicID")).toBe("2026p507720");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));
    const env = await createFakeEnv();

    const result = await getShakingIntensityHandler({ type: "measured" }, env);

    expect(result.isError).toBe(true);
  });
});
