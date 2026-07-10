import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryDataflowHandler } from "../src/tools/queryDataflow.js";
import { clearCache } from "./helpers/cache.js";
import { ensureCredentialsTable, seedSubscriptionKey } from "./helpers/credentials.js";

function fakeSdmxJson() {
  return {
    dataSets: [{ series: { "0": { observations: { "0": [42] } } } }],
    structure: {
      dimensions: {
        series: [
          { id: "FORESTRY_AGR_AGR_001", name: "Forestry", values: [{ id: "1", name: "Exotic" }] },
        ],
        observation: [{ id: "YEAR_AGR_AGR_001", name: "Year", values: [{ id: "2018", name: "2018" }] }],
      },
    },
  };
}

function jsonResponse() {
  return new Response(JSON.stringify(fakeSdmxJson()), { status: 200, headers: { "content-type": "application/json" } });
}

describe("nz_stats_query_dataflow", () => {
  // MCP_CACHE persists across tests within this file (vitest-pool-workers isolates storage
  // per file, not per test, under Vitest 4 — see clearCache's doc comment), so it must be
  // reset between tests that rely on a fresh cache to observe their own fetch mock.
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearCache(env);
  });

  it("returns an actionable error when the subscription key credential is unset", async () => {
    await ensureCredentialsTable(env);
    const result = await queryDataflowHandler({ dataflow_id: "AGR_AGR_001" }, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("STATS_NZ_SUBSCRIPTION_KEY");
  });

  it("flattens a jsondata response and simplifies dataflow-suffixed dimension ids", async () => {
    await seedSubscriptionKey(env);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse()));

    const result = await queryDataflowHandler({ dataflow_id: "AGR_AGR_001" }, env);
    const observations = result.structuredContent?.observations as Array<Record<string, unknown>>;

    expect(observations).toEqual([{ FORESTRY: "1", YEAR: "2018", value: 42 }]);
    expect(result.structuredContent?.raw).toBeNull();
  });

  it("defaults dimension_key to 'all', version to 'latest', and agency_id to STATSNZ", async () => {
    await seedSubscriptionKey(env);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await queryDataflowHandler({ dataflow_id: "AGR_AGR_001" }, env);

    const requestedUrl = String((fetchMock.mock.calls[0]?.[0] as URL | string) ?? "");
    expect(requestedUrl).toContain("/data/STATSNZ,AGR_AGR_001,latest/all");
    expect(requestedUrl).toContain("format=jsondata");
  });

  it("passes through a custom dimension_key, agency_id, and version", async () => {
    await seedSubscriptionKey(env);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await queryDataflowHandler(
      { dataflow_id: "AGR_AGR_001", agency_id: "STATSNZ", version: "1.0", dimension_key: ".1+2.2018" },
      env,
    );

    const requestedUrl = String((fetchMock.mock.calls[0]?.[0] as URL | string) ?? "");
    expect(requestedUrl).toContain("/data/STATSNZ,AGR_AGR_001,1.0/.1+2.2018");
  });

  it("returns raw truncated text for non-jsondata formats", async () => {
    await seedSubscriptionKey(env);
    const csvBody = "a,b,c\n1,2,3\n";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(csvBody, { status: 200, headers: { "content-type": "text/csv" } })),
    );

    const result = await queryDataflowHandler({ dataflow_id: "AGR_AGR_001", format: "csv" }, env);

    expect(result.structuredContent?.raw).toBe(csvBody);
    expect(result.structuredContent?.observations).toEqual([]);
  });

  it("surfaces an actionable error on upstream HTTP failure", async () => {
    // 400 (not 429/5xx) so fetchWithBackoff doesn't spend real time retrying.
    await seedSubscriptionKey(env, "another-unique-test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad request", { status: 400, statusText: "Bad Request" })));

    const result = await queryDataflowHandler({ dataflow_id: "DOES_NOT_EXIST" }, env);

    expect(result.isError).toBe(true);
  });
});
