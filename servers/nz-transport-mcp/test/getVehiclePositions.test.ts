import { afterEach, describe, expect, it, vi } from "vitest";
import { getVehiclePositionsHandler } from "../src/tools/getVehiclePositions.js";
import { makeTestEnv } from "./helpers/env.js";

function feedResponse(entities: unknown[]) {
  // Confirmed live 2026-07-10: AT wraps the GTFS-realtime message in an outer {status, response} envelope.
  return new Response(
    JSON.stringify({ status: "OK", response: { header: { gtfs_realtime_version: "2.0" }, entity: entities } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function sampleVehicle(id: string, routeId: string) {
  return {
    id,
    vehicle: {
      trip: { trip_id: `trip-${id}`, route_id: routeId, direction_id: 0, start_time: "08:00:00", start_date: "20260710" },
      vehicle: { id: `veh-${id}`, label: `Bus ${id}`, license_plate: "ABC123" },
      position: { latitude: -36.85, longitude: 174.76, bearing: 90, speed: 10 },
      timestamp: 1750000000,
      current_status: "IN_TRANSIT_TO",
      current_stop_sequence: 5,
      stop_id: "stop-1",
    },
  };
}

describe("nz_transport_get_vehicle_positions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no AT subscription key is configured", async () => {
    const env = await makeTestEnv();
    const result = await getVehiclePositionsHandler({}, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("AT_SUBSCRIPTION_KEY");
  });

  it("returns concise vehicle summaries, converting speed from m/s to km/h", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse([sampleVehicle("1", "70-202")])));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getVehiclePositionsHandler({}, env);

    expect(result.structuredContent?.items).toEqual([
      {
        vehicle_id: "veh-1",
        route_id: "70-202",
        trip_id: "trip-1",
        latitude: -36.85,
        longitude: 174.76,
        bearing: 90,
        speed_kmh: 36,
        last_updated: new Date(1750000000 * 1000).toISOString(),
      },
    ]);
  });

  it("filters to the requested route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(feedResponse([sampleVehicle("1", "70-202"), sampleVehicle("2", "80-201")])),
    );
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getVehiclePositionsHandler({ route: "80-201" }, env);

    expect(result.structuredContent?.total_count).toBe(1);
    const items = result.structuredContent?.items as Array<Record<string, unknown>>;
    expect(items[0]?.vehicle_id).toBe("veh-2");
  });

  it("includes label, license plate, and status fields in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse([sampleVehicle("1", "70-202")])));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getVehiclePositionsHandler({ response_format: "detailed" }, env);

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.vehicle_label).toBe("Bus 1");
    expect(item?.license_plate).toBe("ABC123");
    expect(item?.current_status).toBe("IN_TRANSIT_TO");
    expect(item?.stop_id).toBe("stop-1");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 502, statusText: "Bad Gateway" })));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getVehiclePositionsHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Auckland Transport returned HTTP 502");
  });
});
