import { afterEach, describe, expect, it, vi } from "vitest";
import { searchSchoolsHandler } from "../src/tools/searchSchools.js";
import { searchEarlyChildhoodServicesHandler } from "../src/tools/searchEarlyChildhoodServices.js";

function datastoreResponse(records: unknown[], total: number) {
  return new Response(JSON.stringify({ success: true, result: { total, records } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE_SCHOOL = {
  School_Id: "7",
  Org_Name: "Okaihau College",
  Org_Type: "Secondary (Year 7-15)",
  Authority: "State",
  Add1_City: "Okaihau",
  Add1_Suburb: "",
  Regional_Council: "Northland Region",
  Territorial_Authority: "Far North District",
  Education_Region: "Tai Tokerau",
  Urban_Rural_Indicator: "Rural settlement",
  CoEd_Status: "Co-Educational",
  Telephone: "09-4019030",
  Email: "admin@okaihau-college.school.nz",
  URL: "http://www.okaihau-college.school.nz",
};

const SAMPLE_ECE = {
  ECE_Id: "5316",
  Org_Name: "Brown Owl Kindergarten",
  Org_Type: "Free Kindergarten",
  Authority: "Community based",
  Add1_City: "Upper Hutt",
  Add1_Suburb: "Timberlea",
  Regional_Council: "Wellington Region",
  Territorial_Authority: "Upper Hutt City",
  Education_Region: "Wellington",
  Urban_Rural_Indicator: "Large urban area",
  "20_Hrs_ECE": "Yes",
  Telephone: "04-526 8806",
  Email: "brownowl@wmkindergartens.org.nz",
};

describe("nz_govt_search_schools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("errors when neither query nor region is provided", async () => {
    const result = await searchSchoolsHandler({});
    expect(result.isError).toBe(true);
  });

  it("returns concise school records", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreResponse([SAMPLE_SCHOOL], 1)));

    const result = await searchSchoolsHandler({ query: "Okaihau" });

    expect(result.structuredContent?.items).toEqual([
      {
        name: "Okaihau College",
        type: "Secondary (Year 7-15)",
        authority: "State",
        city: "Okaihau",
        region: "Northland Region",
      },
    ]);
  });

  it("combines query and region into one full-text search term", async () => {
    const fetchMock = vi.fn().mockResolvedValue(datastoreResponse([], 0));
    vi.stubGlobal("fetch", fetchMock);

    await searchSchoolsHandler({ query: "College", region: "Northland" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("q")).toBe("College Northland");
  });

  it("always requests a stable sort, so paginated calls can't skip or duplicate rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(datastoreResponse([], 0));
    vi.stubGlobal("fetch", fetchMock);

    await searchSchoolsHandler({ query: "College" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("sort")).toBe("_id");
  });

  it("accepts authority or city alone, without query or region", async () => {
    const fetchMock = vi.fn().mockResolvedValue(datastoreResponse([], 0));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchSchoolsHandler({ authority: "State : Integrated" });

    expect(result.isError).toBeUndefined();
    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("filters")).toBe(JSON.stringify({ Authority: "State : Integrated" }));
    expect(requestedUrl.searchParams.has("q")).toBe(false);
  });

  it("combines authority and city into exact-match filters alongside a free-text query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(datastoreResponse([], 0));
    vi.stubGlobal("fetch", fetchMock);

    await searchSchoolsHandler({ region: "Canterbury", authority: "State : Integrated", city: "Christchurch" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("q")).toBe("Canterbury");
    expect(requestedUrl.searchParams.get("filters")).toBe(
      JSON.stringify({ Authority: "State : Integrated", Add1_City: "Christchurch" }),
    );
  });

  it("rejects an authority value outside the confirmed enum", async () => {
    await expect(searchSchoolsHandler({ authority: "Integrated" })).rejects.toThrow();
  });

  it("hints at case-sensitivity when a `city` filter returns nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreResponse([], 0)));

    const result = await searchSchoolsHandler({ city: "christchurch" });

    expect(result.structuredContent?.notice).toContain("case-sensitive");
  });

  it("does not blame city-casing when another filter is also active and returns nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreResponse([], 0)));

    const result = await searchSchoolsHandler({ city: "Christchurch", authority: "Charter School" });

    expect(result.structuredContent?.notice).not.toContain("case-sensitive");
  });

  it("includes contact details in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreResponse([SAMPLE_SCHOOL], 1)));

    const result = await searchSchoolsHandler({ query: "Okaihau", response_format: "detailed" });
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.email).toBe("admin@okaihau-college.school.nz");
    expect(item?.coed_status).toBe("Co-Educational");
  });

  it("surfaces a CKAN-level action failure as a tool error, not an unhandled rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: { message: "boom" } }), { status: 200 }),
      ),
    );

    const result = await searchSchoolsHandler({ query: "Okaihau" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("boom") });
  });

  it("surfaces a malformed (non-JSON) upstream response as a tool error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 200 })),
    );

    const result = await searchSchoolsHandler({ query: "Okaihau" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("could not be reached") });
  });
});

describe("nz_govt_search_early_childhood_services", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("errors when neither query nor region is provided", async () => {
    const result = await searchEarlyChildhoodServicesHandler({});
    expect(result.isError).toBe(true);
  });

  it("returns concise ECE records", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreResponse([SAMPLE_ECE], 1)));

    const result = await searchEarlyChildhoodServicesHandler({ region: "Wellington" });

    expect(result.structuredContent?.items).toEqual([
      {
        name: "Brown Owl Kindergarten",
        type: "Free Kindergarten",
        authority: "Community based",
        city: "Upper Hutt",
        region: "Wellington Region",
      },
    ]);
  });

  it("always requests a stable sort, so paginated calls can't skip or duplicate rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue(datastoreResponse([], 0));
    vi.stubGlobal("fetch", fetchMock);

    await searchEarlyChildhoodServicesHandler({ region: "Wellington" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("sort")).toBe("_id");
  });

  it("accepts authority or city alone, without query or region", async () => {
    const fetchMock = vi.fn().mockResolvedValue(datastoreResponse([], 0));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchEarlyChildhoodServicesHandler({ city: "Christchurch" });

    expect(result.isError).toBeUndefined();
    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("filters")).toBe(JSON.stringify({ Add1_City: "Christchurch" }));
    expect(requestedUrl.searchParams.has("q")).toBe(false);
  });

  it("rejects an authority value outside the confirmed enum", async () => {
    await expect(searchEarlyChildhoodServicesHandler({ authority: "State" })).rejects.toThrow();
  });

  it("hints at case-sensitivity when a `city` filter returns nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreResponse([], 0)));

    const result = await searchEarlyChildhoodServicesHandler({ city: "christchurch" });

    expect(result.structuredContent?.notice).toContain("case-sensitive");
  });

  it("does not blame city-casing when another filter is also active and returns nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreResponse([], 0)));

    const result = await searchEarlyChildhoodServicesHandler({ city: "Christchurch", region: "Wellington" });

    expect(result.structuredContent?.notice).not.toContain("case-sensitive");
  });

  it("includes the 20 Hours ECE flag in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreResponse([SAMPLE_ECE], 1)));

    const result = await searchEarlyChildhoodServicesHandler({ region: "Wellington", response_format: "detailed" });
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.hours_20_ece).toBe("Yes");
  });

  it("surfaces a CKAN-level action failure as a tool error, not an unhandled rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: { message: "boom" } }), { status: 200 }),
      ),
    );

    const result = await searchEarlyChildhoodServicesHandler({ region: "Wellington" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("boom") });
  });

  it("surfaces a malformed (non-JSON) upstream response as a tool error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 200 })),
    );

    const result = await searchEarlyChildhoodServicesHandler({ region: "Wellington" });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("could not be reached") });
  });
});
