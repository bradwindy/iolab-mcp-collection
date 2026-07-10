import { afterEach, describe, expect, it, vi } from "vitest";
import { getMortgageRatesHandler } from "../src/tools/getMortgageRates.js";

const SAMPLE_ENVELOPE = {
  type: "MortgageRates",
  data: [
    {
      id: "institution:anz",
      name: "ANZ",
      products: [
        {
          id: "product:anz:standard",
          name: "Standard",
          rates: [
            { id: "rate:anz:standard:1-year", term: "1 year", termInMonths: 12, rate: 5.25 },
            { id: "rate:anz:standard:2-years", term: "2 years", termInMonths: 24, rate: 5.89 },
          ],
        },
      ],
    },
    {
      id: "institution:asb",
      name: "ASB",
      products: [
        {
          id: "product:asb:standard",
          name: "Standard",
          rates: [{ id: "rate:asb:standard:1-year", term: "1 year", termInMonths: 12, rate: 4.65 }],
        },
      ],
    },
  ],
  lastUpdated: "2026-07-09T08:31:47.692Z",
  termsOfUse: "Data is retrieved hourly from interest.co.nz.",
  timestamp: "2026-07-09T23:03:11.853Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("nz_markets_get_mortgage_rates", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("flattens every institution/product/rate row into a concise list by default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SAMPLE_ENVELOPE)));

    const result = await getMortgageRatesHandler({});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.items).toEqual([
      { institution: "ANZ", product: "Standard", term: "1 year", rate_percent: 5.25 },
      { institution: "ANZ", product: "Standard", term: "2 years", rate_percent: 5.89 },
      { institution: "ASB", product: "Standard", term: "1 year", rate_percent: 4.65 },
    ]);
    expect(result.structuredContent?.total_count).toBe(3);
    expect(result.structuredContent?.data_last_updated).toBe("2026-07-09T08:31:47.692Z");
  });

  it("includes ids and term_in_months in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SAMPLE_ENVELOPE)));

    const result = await getMortgageRatesHandler({ response_format: "detailed" });
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.term_in_months).toBe(12);
    expect(item?.institution_id).toBe("institution:anz");
    expect(item?.rate_id).toBe("rate:anz:standard:1-year");
  });

  it("requests the single-institution endpoint with a normalized id when institution is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_ENVELOPE));
    vi.stubGlobal("fetch", fetchMock);

    await getMortgageRatesHandler({ institution: "Co-operative Bank" });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.pathname).toBe("/api/v1/mortgage-rates/institution:co-operative-bank");
  });

  it("passes term_in_months as a query parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_ENVELOPE));
    vi.stubGlobal("fetch", fetchMock);

    await getMortgageRatesHandler({ term_in_months: 12 });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("termInMonths")).toBe("12");
  });

  it("reports pagination truncation via the notice field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SAMPLE_ENVELOPE)));

    const result = await getMortgageRatesHandler({ limit: 1 });

    expect(result.structuredContent?.total_count).toBe(3);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(1);
    expect(result.structuredContent?.notice).toContain("Showing 1 of 3");
  });

  it("returns an actionable error with a spelling hint on a 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 404, message: "Institution not found" }), { status: 404, statusText: "Not Found" })),
    );

    const result = await getMortgageRatesHandler({ institution: "not-a-real-bank" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Rates API returned HTTP 404");
    expect(result.content[0]?.text).toContain("Check the institution spelling");
  });
});
