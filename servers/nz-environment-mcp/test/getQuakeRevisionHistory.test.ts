import { afterEach, describe, expect, it, vi } from "vitest";
import { getQuakeRevisionHistoryHandler } from "../src/tools/getQuakeRevisionHistory.js";
import { createFakeEnv } from "./testEnv.js";

function historyResponse(features: unknown[]) {
  return new Response(JSON.stringify({ type: "FeatureCollection", features }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function revisionFeature(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [177.4626, -37.143] },
    properties: {
      publicID: "2026p507720",
      time: "2026-07-07T20:33:16.312Z",
      modificationTime: "2026-07-07T20:45:59.407Z",
      depth: 103.9,
      magnitude: 5.39,
      locality: "70 km north of Te Kaha",
      mmi: 4,
      quality: "best",
      ...overrides,
    },
  };
}

describe("nz_env_get_quake_revision_history", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a malformed public_id before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv();

    await expect(getQuakeRevisionHistoryHandler({ public_id: "not-a-quake-id" }, env)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns revision history ordered as GeoNet returns it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        historyResponse([
          revisionFeature({ modificationTime: "2026-07-07T20:45:59.407Z", magnitude: 5.39 }),
          revisionFeature({ modificationTime: "2026-07-07T20:37:04.317Z", magnitude: 5.44 }),
        ]),
      ),
    );
    const env = await createFakeEnv();

    const result = await getQuakeRevisionHistoryHandler({ public_id: "2026p507720" }, env);

    expect(result.structuredContent?.revision_count).toBe(2);
    const revisions = result.structuredContent?.revisions as Array<Record<string, unknown>>;
    expect(revisions[0]?.modification_time).toBe("2026-07-07T20:45:59.407Z");
  });

  it("returns an actionable error when there is no history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));
    const env = await createFakeEnv();

    const result = await getQuakeRevisionHistoryHandler({ public_id: "2026p507720" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No location/magnitude history found");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404, statusText: "Not Found" })));
    const env = await createFakeEnv();

    const result = await getQuakeRevisionHistoryHandler({ public_id: "2026p507720" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("GeoNet API returned HTTP 404");
  });
});
