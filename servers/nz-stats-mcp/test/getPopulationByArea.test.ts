import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPopulationByAreaHandler } from "../src/tools/getPopulationByArea.js";
import { clearCache } from "./helpers/cache.js";
import { ensureCredentialsTable, seedSubscriptionKey } from "./helpers/credentials.js";

/**
 * A plausible SDMX-JSON 2.1 data message for POPES_SUB_004, built against the documented
 * SDMX-JSON shape (see clients/statsNzSdmx.ts). Two areas (Northland, Auckland) x two years
 * (2023, 2024), sex/age fixed at their "Total" codes.
 */
function fakeSdmxJson() {
  return {
    header: { id: "test", prepared: "2026-07-09T00:00:00Z" },
    dataSets: [
      {
        series: {
          "0:0:0": { observations: { "0": [1234], "1": [1250] } },
          "1:0:0": { observations: { "0": [5000], "1": [5100] } },
        },
      },
    ],
    structure: {
      dimensions: {
        series: [
          {
            id: "AREA_POPES_SUB_004",
            name: "Area",
            values: [
              { id: "01", name: "Northland region" },
              { id: "02", name: "Auckland region" },
            ],
          },
          { id: "SEX_POPES_SUB_004", name: "Sex", values: [{ id: "3", name: "Total" }] },
          { id: "AGE_POPES_SUB_004", name: "Age", values: [{ id: "999999", name: "Total all ages" }] },
        ],
        observation: [
          {
            id: "YEAR_POPES_SUB_004",
            name: "Year",
            values: [
              { id: "2023", name: "2023" },
              { id: "2024", name: "2024" },
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

describe("nz_stats_get_population_by_area", () => {
  // MCP_CACHE persists across tests within this file (vitest-pool-workers isolates storage
  // per file, not per test, under Vitest 4 — see clearCache's doc comment), so it must be
  // reset between tests that rely on a fresh cache to observe their own fetch mock.
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearCache(env);
  });

  it("returns an actionable error when the subscription key credential is unset", async () => {
    await ensureCredentialsTable(env);
    const result = await getPopulationByAreaHandler({}, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("STATS_NZ_SUBSCRIPTION_KEY");
  });

  it("returns concise population observations by area and year", async () => {
    await seedSubscriptionKey(env);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse()));

    const result = await getPopulationByAreaHandler({ area_code: "01,02", start_year: 2023, end_year: 2024 }, env);
    const observations = result.structuredContent?.observations as Array<Record<string, unknown>>;

    expect(observations).toHaveLength(4);
    expect(observations).toContainEqual({ area_code: "01", area_name: "Northland region", year: 2023, population: 1234 });
    expect(observations).toContainEqual({ area_code: "02", area_name: "Auckland region", year: 2024, population: 5100 });
    expect(result.structuredContent?.dataflow).toMatchObject({ id: "POPES_SUB_004" });
  });

  it("includes sex/age codes in detailed format", async () => {
    await seedSubscriptionKey(env);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse()));

    const result = await getPopulationByAreaHandler({ area_code: "01", response_format: "detailed" }, env);
    const observations = result.structuredContent?.observations as Array<Record<string, unknown>>;

    expect(observations[0]).toMatchObject({ sex_code: "3", sex_label: "Total", age_code: "999999" });
  });

  it("builds the request URL with the caller's area codes and default sex/age totals", async () => {
    await seedSubscriptionKey(env);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await getPopulationByAreaHandler({ area_code: "02" }, env);

    const requestedUrl = String((fetchMock.mock.calls[0]?.[0] as URL | string) ?? "");
    expect(requestedUrl).toContain("/data/STATSNZ,POPES_SUB_004,1.0/02.3.999999.");
  });

  it("rejects a year outside the dataflow's available years", async () => {
    await seedSubscriptionKey(env);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await getPopulationByAreaHandler({ start_year: 2020, end_year: 2020 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("1996");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a credential hint on a 401 from upstream", async () => {
    await seedSubscriptionKey(env, "yet-another-unique-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ statusCode: 401, message: "Access denied due to missing subscription key." }), {
          status: 401,
          statusText: "Unauthorized",
        }),
      ),
    );

    const result = await getPopulationByAreaHandler({ area_code: "01" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("STATS_NZ_SUBSCRIPTION_KEY");
  });
});
