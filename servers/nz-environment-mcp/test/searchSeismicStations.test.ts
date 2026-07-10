import { afterEach, describe, expect, it, vi } from "vitest";
import { searchSeismicStationsHandler } from "../src/tools/searchSeismicStations.js";
import { createFakeEnv } from "./testEnv.js";

const HEADER = "#Network | Station | Latitude | Longitude | Elevation | SiteName | StartTime | EndTime";
const ROW = "NZ|WEL|-41.284048|174.768184|138.000000|Wellington|1916-01-01T00:00:00|";

function textResponse(rows: string[], status = 200) {
  const body = rows.length > 0 ? [HEADER, ...rows].join("\n") : "";
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("nz_env_search_seismic_stations", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("errors when no search filter is provided", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv();

    const result = await searchSeismicStationsHandler({}, env);

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses station rows and returns concise results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse([ROW])));
    const env = await createFakeEnv();

    const result = await searchSeismicStationsHandler({ network: "NZ", station: "WEL" }, env);

    expect(result.structuredContent?.items).toEqual([
      { network: "NZ", station: "WEL", site_name: "Wellington", longitude: 174.768184, latitude: -41.284048 },
    ]);
  });

  it("includes elevation and open-ended end_time in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse([ROW])));
    const env = await createFakeEnv();

    const result = await searchSeismicStationsHandler({ network: "NZ", response_format: "detailed" }, env);
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.elevation_m).toBe(138);
    expect(item?.end_time).toBeNull();
  });

  it("scopes the request by bbox", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv();

    await searchSeismicStationsHandler({ bbox: [170, -45, 178, -37] }, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("minlatitude")).toBe("-45");
    expect(requestedUrl.searchParams.get("level")).toBe("station");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 500, statusText: "Internal Server Error" })));
    const env = await createFakeEnv();

    const result = await searchSeismicStationsHandler({ network: "NZ" }, env);

    expect(result.isError).toBe(true);
  });
});
