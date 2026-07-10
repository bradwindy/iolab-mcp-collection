import { afterEach, describe, expect, it, vi } from "vitest";
import { searchHighwayIncidentsHandler } from "../src/tools/searchHighwayIncidents.js";
import { makeTestEnv } from "./helpers/env.js";

function eventsEnvelope(events: unknown[] | "") {
  const response = events === "" ? "" : { roadevent: events };
  return new Response(JSON.stringify({ response }), { status: 200, headers: { "content-type": "application/json" } });
}

function sampleEvent(id: number, regionName: string) {
  return {
    id,
    eventType: "Road Hazard",
    eventDescription: "Flooding",
    eventComments: "Take care.",
    impact: "Caution",
    status: "Active",
    planned: false,
    startDate: "2026-07-07T11:51:00+12:00",
    eventCreated: "2026-07-07T11:53:42.940+12:00",
    eventModified: "2026-07-09T19:00:12.117+12:00",
    expectedResolution: "Until further notice",
    locationArea: "SH 1 Milburn",
    locations: ["01S-0746/09.21-B Milburn"],
    alternativeRoute: "Not Applicable.",
    informationSource: "Public",
    supplier: "Official",
    region: { id: "13", name: regionName },
    way: { id: "1047", name: "01S" },
  };
}

describe("nz_transport_search_highway_incidents", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an unknown region before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv();

    const result = await searchHighwayIncidentsHandler({ region: "Narnia" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown region");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches all events and returns concise summaries when no region is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(eventsEnvelope([sampleEvent(554261, "Otago")]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv();

    const result = await searchHighwayIncidentsHandler({}, env);

    expect(result.structuredContent?.items).toEqual([
      {
        id: 554261,
        category: "Road Hazard",
        description: "Flooding",
        status: "Active",
        impact: "Caution",
        region: "Otago",
        location: "SH 1 Milburn",
        planned: false,
        starts: "2026-07-07T11:51:00+12:00",
        ends: null,
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/events/all/-1");
  });

  it("resolves a region name to its numeric id for the upstream request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(eventsEnvelope([sampleEvent(1, "Otago")]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv();

    await searchHighwayIncidentsHandler({ region: "otago" }, env);

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/events/byregion/13/-1");
  });

  it("accepts a numeric region id directly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(eventsEnvelope([sampleEvent(1, "Otago")]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv();

    await searchHighwayIncidentsHandler({ region: "13" }, env);

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/events/byregion/13/-1");
  });

  it("treats the API's empty-string response envelope as zero results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(eventsEnvelope("")));
    const env = await makeTestEnv();

    const result = await searchHighwayIncidentsHandler({ region: "13" }, env);

    expect(result.structuredContent?.items).toEqual([]);
    expect(result.structuredContent?.total_count).toBe(0);
  });

  it("includes comments and location details in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(eventsEnvelope([sampleEvent(1, "Otago")])));
    const env = await makeTestEnv();

    const result = await searchHighwayIncidentsHandler({ response_format: "detailed" }, env);

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.comments).toBe("Take care.");
    expect(item?.state_highway).toBe("01S");
    expect(item?.locations).toEqual(["01S-0746/09.21-B Milburn"]);
  });

  it("caches results per region across repeated calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(eventsEnvelope([sampleEvent(1, "Otago")]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeTestEnv();

    await searchHighwayIncidentsHandler({}, env);
    await searchHighwayIncidentsHandler({}, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));
    const env = await makeTestEnv();

    const result = await searchHighwayIncidentsHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("returned HTTP 503");
  });
});
