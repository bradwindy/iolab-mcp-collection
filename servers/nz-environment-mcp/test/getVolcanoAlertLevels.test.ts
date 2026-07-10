import { afterEach, describe, expect, it, vi } from "vitest";
import { getVolcanoAlertLevelsHandler } from "../src/tools/getVolcanoAlertLevels.js";
import { createFakeEnv } from "./testEnv.js";

function volcanoFeature(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [177.183, -37.521] },
    properties: {
      acc: "Yellow",
      activity: "Moderate to heightened volcanic unrest.",
      hazards: "Volcanic unrest hazards, potential for eruption hazards.",
      level: 2,
      volcanoID: "whiteisland",
      volcanoTitle: "White Island",
      ...overrides,
    },
  };
}

function volcanoResponse(features: unknown[]) {
  return new Response(JSON.stringify({ type: "FeatureCollection", features }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("nz_env_get_volcano_alert_levels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns concise alert levels for all volcanoes by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        volcanoResponse([
          volcanoFeature(),
          volcanoFeature({ volcanoID: "ruapehu", volcanoTitle: "Ruapehu", level: 1, acc: "Green" }),
        ]),
      ),
    );
    const env = await createFakeEnv();

    const result = await getVolcanoAlertLevelsHandler({}, env);

    expect(result.structuredContent?.total_count).toBe(2);
    expect(result.structuredContent?.items).toEqual([
      { volcano_id: "whiteisland", title: "White Island", alert_level: 2, aviation_colour_code: "Yellow", activity: "Moderate to heightened volcanic unrest." },
      { volcano_id: "ruapehu", title: "Ruapehu", alert_level: 1, aviation_colour_code: "Green", activity: "Moderate to heightened volcanic unrest." },
    ]);
  });

  it("filters by volcano id or title, case-insensitively", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        volcanoResponse([volcanoFeature(), volcanoFeature({ volcanoID: "ruapehu", volcanoTitle: "Ruapehu" })]),
      ),
    );
    const env = await createFakeEnv();

    const result = await getVolcanoAlertLevelsHandler({ volcano: "white" }, env);

    expect(result.structuredContent?.total_count).toBe(1);
    const items = result.structuredContent?.items as Array<Record<string, unknown>>;
    expect(items[0]?.volcano_id).toBe("whiteisland");
  });

  it("includes hazards and coordinates in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(volcanoResponse([volcanoFeature()])));
    const env = await createFakeEnv();

    const result = await getVolcanoAlertLevelsHandler({ response_format: "detailed" }, env);
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.hazards).toBe("Volcanic unrest hazards, potential for eruption hazards.");
    expect(item?.latitude).toBeCloseTo(-37.521);
  });

  it("gives a helpful notice when no volcano matches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(volcanoResponse([volcanoFeature()])));
    const env = await createFakeEnv();

    const result = await getVolcanoAlertLevelsHandler({ volcano: "nonexistent" }, env);

    expect(result.structuredContent?.total_count).toBe(0);
    expect(result.structuredContent?.notice).toContain("No volcano matched");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 500, statusText: "Internal Server Error" })));
    const env = await createFakeEnv();

    const result = await getVolcanoAlertLevelsHandler({}, env);

    expect(result.isError).toBe(true);
  });
});
