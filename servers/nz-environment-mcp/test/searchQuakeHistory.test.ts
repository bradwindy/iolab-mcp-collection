import { afterEach, describe, expect, it, vi } from "vitest";
import { searchQuakeHistoryHandler } from "../src/tools/searchQuakeHistory.js";
import { createFakeEnv } from "./testEnv.js";

const HEADER = "#EventID | Time | Latitude | Longitude | Depth/km | Author | Catalog | Contributor | ContributorID | MagType | Magnitude | MagAuthor | EventLocationName | EventType";
const ROW =
  "2026p428526|2026-06-08T13:19:05|-43.147|170.943|5.0|GNS|GNS|GNS|2026p428526|MLv|4.9|GNS|45 km south of Hokitika|earthquake";

function textResponse(rows: string[], status = 200) {
  const body = rows.length > 0 ? [HEADER, ...rows].join("\n") : "";
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("nz_env_search_quake_history", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses the pipe-delimited text response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse([ROW])));
    const env = await createFakeEnv();

    const result = await searchQuakeHistoryHandler(
      { start_time: "2026-06-01", end_time: "2026-07-01", min_magnitude: 4 },
      env,
    );

    expect(result.structuredContent?.total_count).toBe(1);
    expect(result.structuredContent?.items).toEqual([
      {
        event_id: "2026p428526",
        time: "2026-06-08T13:19:05",
        magnitude: 4.9,
        magnitude_type: "MLv",
        depth_km: 5,
        location_name: "45 km south of Hokitika",
        event_type: "earthquake",
      },
    ]);
  });

  it("treats a 204 No Content response as an empty result set", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse([], 204)));
    const env = await createFakeEnv();

    const result = await searchQuakeHistoryHandler({ start_time: "2026-06-01", end_time: "2026-07-01" }, env);

    expect(result.structuredContent?.total_count).toBe(0);
    expect(result.isError).toBeUndefined();
  });

  it("builds the correct query params including bbox and event_type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv();

    await searchQuakeHistoryHandler(
      {
        start_time: "2026-06-01",
        end_time: "2026-07-01",
        bbox: [170, -45, 178, -37],
        event_type: "earthquake",
      },
      env,
    );

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("minlongitude")).toBe("170");
    expect(requestedUrl.searchParams.get("maxlatitude")).toBe("-37");
    expect(requestedUrl.searchParams.get("eventtype")).toBe("earthquake");
    expect(requestedUrl.searchParams.get("format")).toBe("text");
  });

  it("includes longitude/latitude/author in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse([ROW])));
    const env = await createFakeEnv();

    const result = await searchQuakeHistoryHandler(
      { start_time: "2026-06-01", end_time: "2026-07-01", response_format: "detailed" },
      env,
    );
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.latitude).toBeCloseTo(-43.147);
    expect(item?.author).toBe("GNS");
  });

  it("reports pagination truncation via the notice field", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ROW.replace("2026p428526", `2026p42852${i}`));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse(rows)));
    const env = await createFakeEnv();

    const result = await searchQuakeHistoryHandler(
      { start_time: "2026-06-01", end_time: "2026-07-01", limit: 2 },
      env,
    );

    expect(result.structuredContent?.notice).toContain("Showing 2 of 5");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));
    const env = await createFakeEnv();

    const result = await searchQuakeHistoryHandler({ start_time: "2026-06-01", end_time: "2026-07-01" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("GeoNet FDSN Web Services returned HTTP 503");
  });
});
