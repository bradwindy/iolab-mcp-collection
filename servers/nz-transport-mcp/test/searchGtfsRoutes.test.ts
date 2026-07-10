import { afterEach, describe, expect, it, vi } from "vitest";
import { searchGtfsRoutesHandler } from "../src/tools/searchGtfsRoutes.js";
import { makeTestEnv } from "./helpers/env.js";

function routesResponse() {
  return new Response(
    JSON.stringify({
      data: [
        {
          type: "route",
          id: "70-202",
          attributes: {
            route_id: "70-202",
            route_short_name: "70",
            route_long_name: "Britomart to Botany",
            route_type: 3,
            route_color: "0066CC",
            agency_id: "AM",
          },
        },
        {
          type: "route",
          id: "OUTER-201",
          attributes: {
            route_id: "OUTER-201",
            route_short_name: "OUTER",
            route_long_name: "Outer Link",
            route_type: 3,
          },
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("nz_transport_search_gtfs_routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no AT subscription key is configured", async () => {
    const env = await makeTestEnv();
    const result = await searchGtfsRoutesHandler({ query: "70" }, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("AT_SUBSCRIPTION_KEY");
  });

  it("matches by short name and returns concise fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(routesResponse()));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await searchGtfsRoutesHandler({ query: "70" }, env);

    expect(result.structuredContent?.items).toEqual([
      { route_id: "70-202", short_name: "70", long_name: "Britomart to Botany", route_type: 3 },
    ]);
  });

  it("matches by long name (case-insensitive)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(routesResponse()));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await searchGtfsRoutesHandler({ query: "outer link" }, env);

    expect(result.structuredContent?.total_count).toBe(1);
    const items = result.structuredContent?.items as Array<Record<string, unknown>>;
    expect(items[0]?.route_id).toBe("OUTER-201");
  });

  it("includes color and agency_id in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(routesResponse()));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await searchGtfsRoutesHandler({ query: "70", response_format: "detailed" }, env);

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.color).toBe("0066CC");
    expect(item?.agency_id).toBe("AM");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 502, statusText: "Bad Gateway" })));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await searchGtfsRoutesHandler({ query: "70" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Auckland Transport returned HTTP 502");
  });
});
