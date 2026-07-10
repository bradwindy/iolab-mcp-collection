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

  it("includes contact details in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreResponse([SAMPLE_SCHOOL], 1)));

    const result = await searchSchoolsHandler({ query: "Okaihau", response_format: "detailed" });
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.email).toBe("admin@okaihau-college.school.nz");
    expect(item?.coed_status).toBe("Co-Educational");
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

  it("includes the 20 Hours ECE flag in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreResponse([SAMPLE_ECE], 1)));

    const result = await searchEarlyChildhoodServicesHandler({ region: "Wellington", response_format: "detailed" });
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.hours_20_ece).toBe("Yes");
  });
});
