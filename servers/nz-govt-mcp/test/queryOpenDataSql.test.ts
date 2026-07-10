import { afterEach, describe, expect, it, vi } from "vitest";
import { queryOpenDataSqlHandler } from "../src/tools/queryOpenDataSql.js";

function datastoreSqlResponse(records: unknown[]) {
  return new Response(JSON.stringify({ success: true, result: { records } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("nz_govt_query_open_data_sql", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("runs a SELECT statement and returns rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreSqlResponse([{ Org_Name: "Okaihau College" }])));

    const result = await queryOpenDataSqlHandler({
      sql: 'SELECT "Org_Name" FROM "4b292323-9fcc-41f8-814b-3c7b19cf14b3" LIMIT 1',
    });

    expect(result.structuredContent?.rows).toEqual([{ Org_Name: "Okaihau College" }]);
    expect(result.structuredContent?.row_count).toBe(1);
  });

  it("rejects a non-SELECT statement before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOpenDataSqlHandler({ sql: 'DROP TABLE "4b292323-9fcc-41f8-814b-3c7b19cf14b3"' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Only SELECT statements are permitted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a chained second statement even though the string starts with SELECT", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOpenDataSqlHandler({
      sql: 'SELECT 1; DROP TABLE "4b292323-9fcc-41f8-814b-3c7b19cf14b3"',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("single SELECT statement");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("truncates and notes when more than 200 rows come back", async () => {
    const manyRows = Array.from({ length: 250 }, (_, i) => ({ i }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreSqlResponse(manyRows)));

    const result = await queryOpenDataSqlHandler({ sql: 'SELECT * FROM "resource-id"' });

    expect(result.structuredContent?.row_count).toBe(200);
    expect(result.structuredContent?.notice).toContain("Showing the first 200 of 250");
  });
});
