import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBusinessDemographyHandler } from "../src/tools/getBusinessDemography.js";
import { clearCache } from "./helpers/cache.js";
import { ensureCredentialsTable, seedSubscriptionKey } from "./helpers/credentials.js";

/**
 * A plausible SDMX-JSON 2.1 data message for BDS_BDS_004, built against the documented
 * SDMX-JSON shape (see clients/statsNzSdmx.ts). One year (2024) x one industry (TOTAL) x
 * two measures (enterprise count, employee count).
 */
function fakeSdmxJson() {
  return {
    header: { id: "test", prepared: "2026-07-09T00:00:00Z" },
    dataSets: [
      {
        series: {
          "0:0": { observations: { "0": [612345], "1": [2456789] } },
        },
      },
    ],
    structure: {
      dimensions: {
        series: [
          { id: "YEAR_BDS_BDS_004", name: "Year", values: [{ id: "2024", name: "2024" }] },
          { id: "ANZSIC06_BDS_BDS_004", name: "Industry", values: [{ id: "TOTAL", name: "All industries" }] },
        ],
        observation: [
          {
            id: "MEASURE_BDS_BDS_004",
            name: "Measure",
            values: [
              { id: "ECOUNT", name: "Geographic units count" },
              { id: "EMPCOUNT", name: "Employee count" },
            ],
          },
        ],
      },
    },
  };
}

function jsonResponse() {
  return new Response(JSON.stringify(fakeSdmxJson()), { status: 200, headers: { "content-type": "application/json" } });
}

describe("nz_stats_get_business_demography", () => {
  // MCP_CACHE persists across tests within this file (vitest-pool-workers isolates storage
  // per file, not per test, under Vitest 4 — see clearCache's doc comment), so it must be
  // reset between tests that rely on a fresh cache to observe their own fetch mock.
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearCache(env);
  });

  it("returns an actionable error when the subscription key credential is unset", async () => {
    await ensureCredentialsTable(env);
    const result = await getBusinessDemographyHandler({}, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("STATS_NZ_SUBSCRIPTION_KEY");
  });

  it("returns enterprise counts by industry, year, and measure", async () => {
    await seedSubscriptionKey(env);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse()));

    const result = await getBusinessDemographyHandler({ start_year: 2024, end_year: 2024 }, env);
    const observations = result.structuredContent?.observations as Array<Record<string, unknown>>;

    expect(observations).toHaveLength(2);
    expect(observations).toContainEqual({
      year: 2024,
      industry_code: "TOTAL",
      industry_label: "All industries",
      measure: "Geographic units count",
      value: 612345,
    });
  });

  it("defaults industry_code to TOTAL and builds the year.industry.(blank measure) key", async () => {
    await seedSubscriptionKey(env);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await getBusinessDemographyHandler({ start_year: 2024, end_year: 2024 }, env);

    const requestedUrl = String((fetchMock.mock.calls[0]?.[0] as URL | string) ?? "");
    expect(requestedUrl).toContain("/data/STATSNZ,BDS_BDS_004,1.0/2024.TOTAL.");
  });

  it("rejects a year outside the dataflow's documented range", async () => {
    await seedSubscriptionKey(env);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getBusinessDemographyHandler({ start_year: 1990 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("2000");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a reversed range (start_year after end_year) instead of silently querying all years", async () => {
    await seedSubscriptionKey(env);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getBusinessDemographyHandler({ start_year: 2020, end_year: 2015 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("start_year");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an actionable error on a generic upstream failure", async () => {
    // 400 (not 429/5xx) so fetchWithBackoff doesn't spend real time retrying.
    await seedSubscriptionKey(env, "another-unique-test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400, statusText: "Bad Request" })));

    const result = await getBusinessDemographyHandler({ start_year: 2024, end_year: 2024 }, env);

    expect(result.isError).toBe(true);
  });
});
