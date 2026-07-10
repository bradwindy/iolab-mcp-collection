import { afterEach, describe, expect, it, vi } from "vitest";
import { getHighwayCamerasHandler } from "../src/tools/getHighwayCameras.js";
import { makeTestEnv } from "./helpers/env.js";

function camerasEnvelope(cameras: unknown[] | "") {
  const response = cameras === "" ? "" : { camera: cameras };
  return new Response(JSON.stringify({ response }), { status: 200, headers: { "content-type": "application/json" } });
}

function sampleCamera(id: number) {
  return {
    id,
    description: "South along Hinds Highway",
    direction: "Southbound",
    group: "NA",
    highway: "SH1",
    imageUrl: `/camera/${id}.jpg`,
    thumbUrl: `/camera/thumb/${id}.jpg`,
    viewUrl: `/camera/view/${id}`,
    latitude: -43.9196,
    longitude: 171.721,
    name: "SH1 Tinwald",
    offline: false,
    underMaintenance: false,
    sortOrder: 0,
    region: { id: "11", name: "Canterbury" },
    way: { id: "805", name: "01S" },
  };
}

describe("nz_transport_get_highway_cameras", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an unknown region before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv();

    const result = await getHighwayCamerasHandler({ region: "Narnia" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown region");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns concise camera summaries with a full image URL", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(camerasEnvelope([sampleCamera(714)])));
    const env = await makeTestEnv();

    const result = await getHighwayCamerasHandler({}, env);

    expect(result.structuredContent?.items).toEqual([
      {
        id: 714,
        name: "SH1 Tinwald",
        highway: "SH1",
        direction: "Southbound",
        region: "Canterbury",
        latitude: -43.9196,
        longitude: 171.721,
        image_url: "https://trafficnz.info/camera/714.jpg",
        offline: false,
      },
    ]);
  });

  it("resolves a numeric region id in the upstream request path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(camerasEnvelope([sampleCamera(714)]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv();

    await getHighwayCamerasHandler({ region: "Canterbury" }, env);

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/cameras/byregion/11");
  });

  it("includes thumbnail/view URLs and maintenance flag in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(camerasEnvelope([sampleCamera(714)])));
    const env = await makeTestEnv();

    const result = await getHighwayCamerasHandler({ response_format: "detailed" }, env);

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.thumbnail_url).toBe("https://trafficnz.info/camera/thumb/714.jpg");
    expect(item?.view_url).toBe("https://trafficnz.info/camera/view/714");
    expect(item?.under_maintenance).toBe(false);
    expect(item?.state_highway).toBe("01S");
  });

  it("treats the API's empty-string response envelope as zero results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(camerasEnvelope("")));
    const env = await makeTestEnv();

    const result = await getHighwayCamerasHandler({}, env);

    expect(result.structuredContent?.items).toEqual([]);
    expect(result.structuredContent?.total_count).toBe(0);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 500, statusText: "Internal Server Error" })));
    const env = await makeTestEnv();

    const result = await getHighwayCamerasHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("returned HTTP 500");
  });
});
