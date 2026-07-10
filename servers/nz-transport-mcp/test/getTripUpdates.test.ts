import { afterEach, describe, expect, it, vi } from "vitest";
import { getTripUpdatesHandler } from "../src/tools/getTripUpdates.js";
import { makeTestEnv } from "./helpers/env.js";

function feedResponse(entities: unknown[]) {
  // Confirmed live 2026-07-10: AT wraps the GTFS-realtime message in an outer {status, response} envelope.
  return new Response(
    JSON.stringify({ status: "OK", response: { header: { gtfs_realtime_version: "2.0" }, entity: entities } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function sampleTripUpdate(id: string, routeId: string, stopUpdateCount = 2) {
  const stopTimeUpdate = Array.from({ length: stopUpdateCount }, (_, i) => ({
    stop_sequence: i + 1,
    stop_id: `stop-${i + 1}`,
    arrival: { delay: 60 + i, ...(i === 0 ? { time: 1750000060 } : {}) },
    departure: { delay: 65 + i },
  }));
  return {
    id,
    trip_update: {
      trip: { trip_id: `trip-${id}`, route_id: routeId },
      vehicle: { id: `veh-${id}` },
      // Confirmed live 2026-07-10: AT's serializer collapses a single-item repeated field to a
      // bare object rather than a one-element array — reproduce that shape here, not just the array.
      stop_time_update: stopUpdateCount === 1 ? stopTimeUpdate[0] : stopTimeUpdate,
      timestamp: 1750000000,
    },
  };
}

describe("nz_transport_get_trip_updates", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no AT subscription key is configured", async () => {
    const env = await makeTestEnv();
    const result = await getTripUpdatesHandler({}, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("AT_SUBSCRIPTION_KEY");
  });

  it("returns concise trip update summaries derived from the first stop_time_update", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse([sampleTripUpdate("1", "70-202")])));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getTripUpdatesHandler({}, env);

    expect(result.structuredContent?.items).toEqual([
      {
        trip_id: "trip-1",
        route_id: "70-202",
        vehicle_id: "veh-1",
        delay_seconds: 60,
        next_stop: { stop_id: "stop-1", arrival_delay_seconds: 60, departure_delay_seconds: 65 },
        stop_updates_count: 2,
        last_updated: new Date(1750000000 * 1000).toISOString(),
      },
    ]);
  });

  it("handles a single stop_time_update arriving as a bare object, not an array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse([sampleTripUpdate("1", "70-202", 1)])));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getTripUpdatesHandler({}, env);

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.stop_updates_count).toBe(1);
    expect(item?.next_stop).toEqual({ stop_id: "stop-1", arrival_delay_seconds: 60, departure_delay_seconds: 65 });
  });

  it("filters to the requested route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(feedResponse([sampleTripUpdate("1", "70-202"), sampleTripUpdate("2", "80-201")])),
    );
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getTripUpdatesHandler({ route: "80-201" }, env);

    expect(result.structuredContent?.total_count).toBe(1);
  });

  it("caps stop_updates at 20 and flags truncation in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse([sampleTripUpdate("1", "70-202", 25)])));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getTripUpdatesHandler({ response_format: "detailed" }, env);

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect((item?.stop_updates as unknown[]).length).toBe(20);
    expect(item?.stop_updates_truncated).toBe(true);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 500, statusText: "Internal Server Error" })));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getTripUpdatesHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Auckland Transport returned HTTP 500");
  });
});
