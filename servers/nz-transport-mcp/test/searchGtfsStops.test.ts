import { afterEach, describe, expect, it, vi } from "vitest";
import { searchGtfsStopsHandler } from "../src/tools/searchGtfsStops.js";
import { makeTestEnv } from "./helpers/env.js";

function stopsResponse() {
  return new Response(
    JSON.stringify({
      data: [
        {
          type: "stop",
          id: "1",
          attributes: {
            stop_id: "0100",
            stop_code: "0100",
            stop_name: "Britomart Train Station",
            stop_lat: -36.8443,
            stop_lon: 174.768,
            location_type: 1,
            wheelchair_boarding: 1,
          },
        },
        {
          type: "stop",
          id: "2",
          attributes: {
            stop_id: "9218",
            stop_code: "9218",
            stop_name: "Aotea Square",
            stop_lat: -36.85,
            stop_lon: 174.76,
            location_type: 0,
            wheelchair_boarding: 0,
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("nz_transport_search_gtfs_stops", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no AT subscription key is configured", async () => {
    const env = await makeTestEnv();
    const result = await searchGtfsStopsHandler({ query: "britomart" }, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("AT_SUBSCRIPTION_KEY");
  });

  it("matches case-insensitively and returns concise fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(stopsResponse());
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await searchGtfsStopsHandler({ query: "britomart" }, env);

    expect(result.structuredContent?.items).toEqual([
      { stop_id: "0100", stop_code: "0100", name: "Britomart Train Station", latitude: -36.8443, longitude: 174.768 },
    ]);
    const requestedUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(requestedUrl).toContain("filter[date]=");
  });

  it("includes location_type and wheelchair_boarding in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stopsResponse()));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await searchGtfsStopsHandler({ query: "aotea", response_format: "detailed" }, env);

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.location_type).toBe(0);
    expect(item?.wheelchair_boarding).toBe(0);
  });

  it("caches the full stop list across repeated calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(stopsResponse());
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    await searchGtfsStopsHandler({ query: "britomart" }, env);
    await searchGtfsStopsHandler({ query: "aotea" }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await searchGtfsStopsHandler({ query: "britomart" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Auckland Transport returned HTTP 503");
  });
});
