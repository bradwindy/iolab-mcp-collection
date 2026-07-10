import { describe, expect, it } from "vitest";
import { getBasemapStyleUrlHandler } from "../src/tools/getBasemapStyleUrl.js";
import { buildFakeEnv } from "./fixtures.js";

describe("nz_geo_get_basemap_style_url", () => {
  it("returns an actionable error when LINZ_BASEMAPS_API_KEY is not configured", async () => {
    const { env } = await buildFakeEnv();
    const result = await getBasemapStyleUrlHandler({}, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("LINZ_BASEMAPS_API_KEY");
  });

  it("masks the real key behind a placeholder by default", async () => {
    const { env } = await buildFakeEnv({ LINZ_BASEMAPS_API_KEY: "test-basemaps-key" });
    const result = await getBasemapStyleUrlHandler({ tileset: "aerial", kind: "xyz" }, env);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.url).not.toContain("test-basemaps-key");
    expect(result.structuredContent?.url).toContain("YOUR_LINZ_BASEMAPS_API_KEY");
    expect(result.structuredContent?.notes).toContain("reveal_key: true");
  });

  it("builds an XYZ tile URL template with the real key injected when reveal_key is true", async () => {
    const { env } = await buildFakeEnv({ LINZ_BASEMAPS_API_KEY: "test-basemaps-key" });
    const result = await getBasemapStyleUrlHandler(
      { tileset: "aerial", kind: "xyz", crs: "3857", image_format: "webp", reveal_key: true },
      env,
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.url).toBe(
      "https://basemaps.linz.govt.nz/v1/tiles/aerial/3857/{z}/{x}/{y}.webp?api=test-basemaps-key",
    );
    expect(result.structuredContent?.placeholders).toEqual(["{z}", "{x}", "{y}"]);
  });

  it("builds a WMTS capabilities URL with the real key injected when reveal_key is true", async () => {
    const { env } = await buildFakeEnv({ LINZ_BASEMAPS_API_KEY: "test-basemaps-key" });
    const result = await getBasemapStyleUrlHandler({ tileset: "aerial", kind: "wmts", reveal_key: true }, env);

    expect(result.structuredContent?.url).toBe(
      "https://basemaps.linz.govt.nz/v1/tiles/aerial/EPSG:3857/WMTSCapabilities.xml?api=test-basemaps-key",
    );
  });

  it("builds a vector style JSON URL for the topographic tileset with the real key injected when reveal_key is true", async () => {
    const { env } = await buildFakeEnv({ LINZ_BASEMAPS_API_KEY: "test-basemaps-key" });
    const result = await getBasemapStyleUrlHandler({ tileset: "topographic", kind: "style", reveal_key: true }, env);

    expect(result.structuredContent?.url).toBe(
      "https://basemaps.linz.govt.nz/v1/tiles/topographic/EPSG:3857/style/topographic.json?api=test-basemaps-key",
    );
  });

  it("rejects a vector style request for the aerial tileset with an actionable error", async () => {
    const { env } = await buildFakeEnv({ LINZ_BASEMAPS_API_KEY: "test-basemaps-key" });
    const result = await getBasemapStyleUrlHandler({ tileset: "aerial", kind: "style" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("topographic");
  });
});
