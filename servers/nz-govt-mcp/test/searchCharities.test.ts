import { afterEach, describe, expect, it, vi } from "vitest";
import { searchCharitiesHandler } from "../src/tools/searchCharities.js";

function odataResponse(records: unknown[], count: number) {
  return new Response(JSON.stringify({ d: { results: records, __count: String(count) } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE_CHARITY = {
  OrganisationId: 32585,
  Name: "Aiga Salevalasi Charitable Trust",
  CharityRegistrationNumber: "CC48103",
  RegistrationStatus: "Registered",
  DateRegistered: "2012-07-09T00:00:00Z",
  DeregistrationDate: null,
  WebSiteURL: "www.asaa.net.nz",
  CharityEmailAddress: "paulriko@netscape.net",
  PostalAddressCity: "Auckland",
  PostalAddressSuburb: "Henderson",
  OrganisationalType: "0",
};

describe("nz_govt_search_charities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("errors when neither query nor registration_number is provided", async () => {
    const result = await searchCharitiesHandler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("query");
  });

  it("returns concise results by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(odataResponse([SAMPLE_CHARITY], 1));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchCharitiesHandler({ query: "Aiga" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.items).toEqual([
      {
        registration_number: "CC48103",
        name: "Aiga Salevalasi Charitable Trust",
        status: "Registered",
        date_registered: "2012-07-09T00:00:00Z",
        city: "Auckland",
      },
    ]);
    expect(result.structuredContent?.total_count).toBe(1);
    expect(result.structuredContent?.has_more).toBe(false);
  });

  it("includes extra fields in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(odataResponse([SAMPLE_CHARITY], 1)));

    const result = await searchCharitiesHandler({ query: "Aiga", response_format: "detailed" });

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.website).toBe("www.asaa.net.nz");
    expect(item?.email).toBe("paulriko@netscape.net");
  });

  it("builds the correct OData $filter for a name query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(odataResponse([], 0));
    vi.stubGlobal("fetch", fetchMock);

    await searchCharitiesHandler({ query: "Sal'vation" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("$filter")).toBe("substringof('Sal''vation', Name)");
  });

  it("filters by exact registration number", async () => {
    const fetchMock = vi.fn().mockResolvedValue(odataResponse([SAMPLE_CHARITY], 1));
    vi.stubGlobal("fetch", fetchMock);

    await searchCharitiesHandler({ registration_number: "CC48103" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("$filter")).toBe("CharityRegistrationNumber eq 'CC48103'");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));

    const result = await searchCharitiesHandler({ query: "Aiga" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Charities Services Open Data returned HTTP 503");
  });

  it("reports pagination truncation via the notice field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(odataResponse([SAMPLE_CHARITY], 500)));

    const result = await searchCharitiesHandler({ query: "Trust", limit: 1 });

    expect(result.structuredContent?.notice).toContain("Showing 1 of 500");
  });
});
