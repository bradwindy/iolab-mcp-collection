import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchDataflowsHandler } from "../src/tools/searchDataflows.js";
import { clearCache } from "./helpers/cache.js";
import { ensureCredentialsTable, seedSubscriptionKey } from "./helpers/credentials.js";

const FAKE_CATALOGUE_XML = `<?xml version="1.0" encoding="utf-8"?>
<message:Structure xmlns:message="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" xmlns:structure="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" xmlns:common="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common">
  <message:Structures>
    <structure:Dataflows>
      <structure:Dataflow id="POPES_SUB_004" agencyID="STATSNZ" version="1.0" isFinal="false">
        <common:Name xml:lang="en">Subnational population estimates (RC, SA2), by age and sex, at 30 June 1996-2025 (2025 boundaries)</common:Name>
      </structure:Dataflow>
      <structure:Dataflow id="POPES_SUB_009" agencyID="STATSNZ" version="1.0" isFinal="false">
        <common:Name xml:lang="en">Subnational population estimates (urban rural), by age and sex, at 30 June 1996-2025 (2025 boundaries)</common:Name>
      </structure:Dataflow>
      <structure:Dataflow id="BDS_BDS_004" agencyID="STATSNZ" version="1.0" isFinal="false">
        <common:Name xml:lang="en">Enterprises by industry 2000-2025</common:Name>
      </structure:Dataflow>
    </structure:Dataflows>
  </message:Structures>
</message:Structure>`;

function xmlResponse() {
  return new Response(FAKE_CATALOGUE_XML, { status: 200, headers: { "content-type": "application/vnd.sdmx.structure+xml; version=2.1" } });
}

describe("nz_stats_search_dataflows", () => {
  // MCP_CACHE persists across tests within this file (vitest-pool-workers isolates storage
  // per file, not per test, under Vitest 4 — see clearCache's doc comment), so it must be
  // reset between tests that rely on a fresh cache to observe their own fetch mock.
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearCache(env);
  });

  it("returns an actionable error when the subscription key credential is unset", async () => {
    await ensureCredentialsTable(env);
    const result = await searchDataflowsHandler({ query: "population" }, env);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("STATS_NZ_SUBSCRIPTION_KEY");
  });

  it("returns concise matches by keyword", async () => {
    await seedSubscriptionKey(env);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse()));

    const result = await searchDataflowsHandler({ query: "population" }, env);

    expect(result.structuredContent?.total_count).toBe(2);
    expect(result.structuredContent?.items).toEqual([
      { dataflow_id: "POPES_SUB_004", name: "Subnational population estimates (RC, SA2), by age and sex, at 30 June 1996-2025 (2025 boundaries)" },
      { dataflow_id: "POPES_SUB_009", name: "Subnational population estimates (urban rural), by age and sex, at 30 June 1996-2025 (2025 boundaries)" },
    ]);
  });

  it("includes agency_id and version in detailed format", async () => {
    await seedSubscriptionKey(env);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse()));

    const result = await searchDataflowsHandler({ query: "enterprises", response_format: "detailed" }, env);
    const items = result.structuredContent?.items as Array<Record<string, unknown>>;

    expect(items).toEqual([{ dataflow_id: "BDS_BDS_004", agency_id: "STATSNZ", version: "1.0", name: "Enterprises by industry 2000-2025" }]);
  });

  it("paginates results", async () => {
    await seedSubscriptionKey(env);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(xmlResponse()));

    const result = await searchDataflowsHandler({ query: "population", limit: 1 }, env);

    expect(result.structuredContent?.total_count).toBe(2);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(1);
    expect((result.structuredContent?.items as unknown[]).length).toBe(1);
  });

  it("caches the catalogue so a repeated search does not refetch upstream", async () => {
    await seedSubscriptionKey(env);
    const fetchMock = vi.fn().mockResolvedValue(xmlResponse());
    vi.stubGlobal("fetch", fetchMock);

    await searchDataflowsHandler({ query: "population" }, env);
    await searchDataflowsHandler({ query: "enterprises" }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces an actionable error on upstream HTTP failure", async () => {
    // 400 (not 429/5xx) so fetchWithBackoff doesn't spend real time retrying.
    await seedSubscriptionKey(env, "another-unique-test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 400, statusText: "Bad Request" })));

    const result = await searchDataflowsHandler({ query: "something-not-cached-yet" }, env);

    expect(result.isError).toBe(true);
  });
});
