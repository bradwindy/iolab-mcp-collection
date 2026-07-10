import { afterEach, describe, expect, it, vi } from "vitest";
import { getRealtimeAlertsHandler } from "../src/tools/getRealtimeAlerts.js";
import { makeTestEnv } from "./helpers/env.js";

function feedResponse(entities: unknown[]) {
  // Confirmed live 2026-07-10: AT wraps the GTFS-realtime message in an outer {status, response}
  // envelope. Each "repeated" field below is also a bare object rather than a one-element array —
  // AT's serializer collapses single-item repeated fields, which is the real shape a typical alert
  // (one language, one active period, one informed route) arrives in.
  return new Response(
    JSON.stringify({
      status: "OK",
      response: { header: { gtfs_realtime_version: "2.0", timestamp: 1750000000 }, entity: entities },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function sampleAlert(id: string, routeId: string) {
  return {
    id,
    alert: {
      cause: "CONSTRUCTION",
      effect: "DETOUR",
      header_text: { translation: { text: `Detour on ${routeId}`, language: "en" } },
      description_text: { translation: { text: "Long-form description", language: "en" } },
      active_period: { start: 1750000000, end: 1750100000 },
      informed_entity: { route_id: routeId },
    },
  };
}

describe("nz_transport_get_realtime_alerts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no AT subscription key is configured", async () => {
    const env = await makeTestEnv();
    const result = await getRealtimeAlertsHandler({}, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("AT_SUBSCRIPTION_KEY");
  });

  it("returns concise alert summaries and sends the subscription key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(feedResponse([sampleAlert("a1", "70-202")]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getRealtimeAlertsHandler({}, env);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.items).toEqual([
      {
        id: "a1",
        cause: "CONSTRUCTION",
        effect: "DETOUR",
        header: "Detour on 70-202",
        affected_routes: ["70-202"],
        active_from: new Date(1750000000 * 1000).toISOString(),
        active_to: new Date(1750100000 * 1000).toISOString(),
      },
    ]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("secret-key");
  });

  it("filters to the requested route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse([sampleAlert("a1", "70-202"), sampleAlert("a2", "80-201")])));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getRealtimeAlertsHandler({ route: "80-201" }, env);

    expect(result.structuredContent?.total_count).toBe(1);
    const items = result.structuredContent?.items as Array<Record<string, unknown>>;
    expect(items[0]?.id).toBe("a2");
  });

  it("includes description and informed_entities in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse([sampleAlert("a1", "70-202")])));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getRealtimeAlertsHandler({ response_format: "detailed" }, env);

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.description).toBe("Long-form description");
    expect(item?.informed_entities).toEqual([{ route_id: "70-202" }]);
  });

  it("reports pagination truncation via the notice field", async () => {
    const entities = Array.from({ length: 5 }, (_, i) => sampleAlert(`a${i}`, "70-202"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(feedResponse(entities)));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getRealtimeAlertsHandler({ limit: 2 }, env);

    expect(result.structuredContent?.notice).toContain("Showing 2 of 5");
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(2);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));
    const env = await makeTestEnv({ atSubscriptionKey: "secret-key" });

    const result = await getRealtimeAlertsHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Auckland Transport returned HTTP 503");
  });
});
