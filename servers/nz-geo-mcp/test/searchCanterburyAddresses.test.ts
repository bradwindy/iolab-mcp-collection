import { afterEach, describe, expect, it, vi } from "vitest";
import { searchCanterburyAddressesHandler } from "../src/tools/searchCanterburyAddresses.js";

function geocodeResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("nz_geo_search_canterbury_addresses", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns address candidates from the primary address locator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        geocodeResponse({
          candidates: [
            {
              address: "200 Tuam Street, Addington-Linwood",
              score: 97.18,
              location: { x: 172.6384545, y: -43.535646 },
              attributes: { Addr_type: "PointAddress" },
            },
          ],
        }),
      ),
    );

    const result = await searchCanterburyAddressesHandler({ query: "200 Tuam Street Christchurch" });

    expect(result.isError).toBeUndefined();
    const candidates = result.structuredContent?.candidates as Array<Record<string, unknown>>;
    expect(candidates[0]).toMatchObject({
      matched_address: "200 Tuam Street, Addington-Linwood",
      matched_by: "address",
      lat: -43.535646,
      lon: 172.6384545,
    });
  });

  it("falls back to the places locator when the address locator finds nothing", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("Canterbury_Composite_Locator")) return geocodeResponse({ candidates: [] });
      return geocodeResponse({
        candidates: [
          {
            address: "North Hagley Park",
            score: 82.96,
            location: { x: 172.62025192, y: -43.52743835 },
            extent: { xmin: 172.61825192, ymin: -43.52943835, xmax: 172.62225192, ymax: -43.52543835 },
            attributes: {},
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchCanterburyAddressesHandler({ query: "Hagley Park", response_format: "detailed" });

    const candidates = result.structuredContent?.candidates as Array<Record<string, unknown>>;
    expect(candidates[0]?.matched_by).toBe("place");
    expect(candidates[0]?.bbox).toBeDefined();
  });

  it("returns a helpful notice when no match is found in either locator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => geocodeResponse({ candidates: [] })),
    );

    const result = await searchCanterburyAddressesHandler({ query: "zzzznotarealplace" });

    expect(result.structuredContent?.count).toBe(0);
    expect(result.structuredContent?.notice).toContain("No address or place match found");
  });
});
