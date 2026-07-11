import { afterEach, describe, expect, it, vi } from "vitest";
import { queryOpenDataSqlHandler } from "../src/tools/queryOpenDataSql.js";

function createFakeCache() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function fakeEnv(): Env {
  return { MCP_CACHE: createFakeCache() } as unknown as Env;
}

function datastoreSqlResponse(records: unknown[]) {
  return new Response(JSON.stringify({ success: true, result: { records } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function htmlErrorPageResponse() {
  return new Response("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

describe("nz_govt_query_open_data_sql", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("runs a SELECT statement and returns rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreSqlResponse([{ Org_Name: "Okaihau College" }])));

    const result = await queryOpenDataSqlHandler(
      { sql: 'SELECT "Org_Name" FROM "4b292323-9fcc-41f8-814b-3c7b19cf14b3" LIMIT 1' },
      fakeEnv(),
    );

    expect(result.structuredContent?.rows).toEqual([{ Org_Name: "Okaihau College" }]);
    expect(result.structuredContent?.row_count).toBe(1);
  });

  it("rejects a non-SELECT statement before making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOpenDataSqlHandler({ sql: 'DROP TABLE "4b292323-9fcc-41f8-814b-3c7b19cf14b3"' }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Only SELECT statements are permitted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a chained second statement even though the string starts with SELECT", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOpenDataSqlHandler(
      { sql: 'SELECT 1; DROP TABLE "4b292323-9fcc-41f8-814b-3c7b19cf14b3"' },
      fakeEnv(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("single SELECT statement");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a CKAN-level action failure (e.g. a resource that isn't datastore-enabled) as a tool error", async () => {
    // CKAN responds 2xx with its own {success: false} envelope for this — e.g. querying a resource
    // id that isn't datastore-enabled, or a syntax error in the SQL itself.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: { message: "relation not found" } }), { status: 200 }),
      ),
    );

    const result = await queryOpenDataSqlHandler({ sql: 'SELECT * FROM "not-a-real-resource"' }, fakeEnv());
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("relation not found") });
  });

  it("surfaces a malformed (non-JSON) upstream response as a tool error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlErrorPageResponse()));

    const result = await queryOpenDataSqlHandler({ sql: 'SELECT * FROM "resource-id"' }, fakeEnv());
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("could not be reached") });
  });

  it("retries and recovers when data.govt.nz's own backend briefly serves an HTML error page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlErrorPageResponse())
      .mockResolvedValueOnce(datastoreSqlResponse([{ Org_Name: "Okaihau College" }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await queryOpenDataSqlHandler({ sql: 'SELECT * FROM "resource-id"' }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.row_count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches the upstream fetch across calls for the same SQL", async () => {
    const env = fakeEnv();
    const fetchMock = vi.fn().mockResolvedValue(datastoreSqlResponse([{ Org_Name: "Okaihau College" }]));
    vi.stubGlobal("fetch", fetchMock);

    await queryOpenDataSqlHandler({ sql: 'SELECT * FROM "resource-id"' }, env);
    await queryOpenDataSqlHandler({ sql: 'SELECT * FROM "resource-id"' }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("truncates and notes when more than 200 rows come back", async () => {
    const manyRows = Array.from({ length: 250 }, (_, i) => ({ i }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(datastoreSqlResponse(manyRows)));

    const result = await queryOpenDataSqlHandler({ sql: 'SELECT * FROM "resource-id"' }, fakeEnv());

    expect(result.structuredContent?.row_count).toBe(200);
    expect(result.structuredContent?.notice).toContain("Showing the first 200 of 250");
  });
});
