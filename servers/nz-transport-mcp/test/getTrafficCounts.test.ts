import { afterEach, describe, expect, it, vi } from "vitest";
import { getTrafficCountsHandler } from "../src/tools/getTrafficCounts.js";

const SAMPLE_ROW = {
  OBJECTID: 1,
  startDate: 1514764800000, // 2018-01-01T00:00:00Z
  siteID: 39,
  regionName: "05 - Gisborne",
  SiteRef: "00200444",
  classWeight: "Light",
  siteDescription: "200 m Nth of Bell Rd",
  laneNumber: 2,
  flowDirection: 2,
  trafficCount: 2468,
};

function arcgisMock(rows: unknown[], count: number) {
  return vi.fn(async (input: string | URL) => {
    const url = new URL(input.toString());
    if (url.searchParams.get("returnCountOnly") === "true") {
      return new Response(JSON.stringify({ count }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ features: rows.map((attributes) => ({ attributes })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("nz_transport_get_traffic_counts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns concise rows with a plain ISO date", async () => {
    vi.stubGlobal("fetch", arcgisMock([SAMPLE_ROW], 1));

    const result = await getTrafficCountsHandler({});

    expect(result.structuredContent?.items).toEqual([
      {
        site_ref: "00200444",
        region: "05 - Gisborne",
        description: "200 m Nth of Bell Rd",
        date: "2018-01-01",
        vehicle_class: "Light",
        lane: 2,
        count: 2468,
      },
    ]);
    expect(result.structuredContent?.total_count).toBe(1);
  });

  it("includes site_id and flow_direction_code in detailed format", async () => {
    vi.stubGlobal("fetch", arcgisMock([SAMPLE_ROW], 1));

    const result = await getTrafficCountsHandler({ response_format: "detailed" });

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.site_id).toBe(39);
    expect(item?.flow_direction_code).toBe(2);
  });

  it("builds a where clause with site_id, region, and date range filters", async () => {
    const fetchMock = arcgisMock([SAMPLE_ROW], 1);
    vi.stubGlobal("fetch", fetchMock);

    await getTrafficCountsHandler({
      site_id: "00200444",
      region: "Gisborne",
      start_date: "2026-01-01",
      end_date: "2026-01-31",
    });

    const countUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    const where = countUrl.searchParams.get("where") ?? "";
    expect(where).toContain("SiteRef = '00200444'");
    expect(where).toContain("UPPER(regionName) LIKE UPPER('%Gisborne%')");
    expect(where).toContain("startDate >= DATE '2026-01-01'");
    expect(where).toContain("startDate <= DATE '2026-01-31'");
  });

  it("rejects a malformed start_date before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getTrafficCountsHandler({ start_date: "07-10-2026" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports pagination truncation via the notice field", async () => {
    vi.stubGlobal("fetch", arcgisMock([SAMPLE_ROW], 500));

    const result = await getTrafficCountsHandler({ limit: 1 });

    expect(result.structuredContent?.notice).toContain("Showing 1 of 500");
  });

  it("returns an actionable error when ArcGIS reports a query error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: { code: 400, message: "Invalid query parameters." } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await getTrafficCountsHandler({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid query parameters.");
  });
});
