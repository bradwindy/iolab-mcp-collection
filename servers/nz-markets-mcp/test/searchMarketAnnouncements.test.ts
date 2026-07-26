import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey, setCredential } from "@iolab/credentials";
import { searchMarketAnnouncementsHandler } from "../src/tools/searchMarketAnnouncements.js";
import { NZXPLORER_API_KEY, SERVER_SLUG } from "../src/constants.js";
import { createFakeCredentialsDb } from "./fakeCredentialsDb.js";
import { createFakeKv } from "./fakeKv.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function makeEnv() {
  const encryptionKey = generateEncryptionKey();
  const db = createFakeCredentialsDb();
  await setCredential(db, SERVER_SLUG, NZXPLORER_API_KEY, "test-key", encryptionKey);
  return { CREDENTIALS_DB: db, ENCRYPTION_KEY: encryptionKey, MCP_CACHE: createFakeKv() } as unknown as Env;
}

describe("nz_markets_search_market_announcements", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no NZXplorer key is configured", async () => {
    const env = { CREDENTIALS_DB: createFakeCredentialsDb(), ENCRYPTION_KEY: generateEncryptionKey(), MCP_CACHE: createFakeKv() } as unknown as Env;

    const result = await searchMarketAnnouncementsHandler({ ticker: "FPH" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NZXPLORER_API_KEY");
  });

  it("requires at least a query or a ticker", async () => {
    const env = await makeEnv();

    const result = await searchMarketAnnouncementsHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("query");
  });

  it("picks known field names for the concise view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [{ id: 1, ticker: "FPH", title: "Half Year Result", type: "HALFYR", date: "2026-02-20", url: "https://example.test/1.pdf" }],
          meta: { total: 1 },
        }),
      ),
    );
    const env = await makeEnv();

    const result = await searchMarketAnnouncementsHandler({ ticker: "FPH" }, env);

    expect(result.structuredContent?.items).toEqual([
      { id: 1, ticker: "FPH", title: "Half Year Result", type: "HALFYR", date: "2026-02-20", url: "https://example.test/1.pdf" },
    ]);
  });

  it("falls back to alternate field-name variants when the primary ones are absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          data: [{ announcement_id: 2, company_ticker: "AIR", headline: "Market Update", announcement_type: "MKTUPDTE", published_date: "2026-03-01", pdf_url: "https://example.test/2.pdf" }],
          meta: { total: 1 },
        }),
      ),
    );
    const env = await makeEnv();

    const result = await searchMarketAnnouncementsHandler({ ticker: "AIR" }, env);

    expect(result.structuredContent?.items).toEqual([
      { id: 2, ticker: "AIR", title: "Market Update", type: "MKTUPDTE", date: "2026-03-01", url: "https://example.test/2.pdf" },
    ]);
  });

  it("includes the full raw record in detailed format", async () => {
    const raw = { id: 1, ticker: "FPH", title: "Half Year Result", extra_field: "keep me" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [raw], meta: { total: 1 } })));
    const env = await makeEnv();

    const result = await searchMarketAnnouncementsHandler({ ticker: "FPH", response_format: "detailed" }, env);
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.raw).toEqual(raw);
  });

  it("passes ticker, type, and date range through as upstream query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [], meta: { total: 0 } }));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeEnv();

    await searchMarketAnnouncementsHandler(
      { ticker: "fph", announcement_type: "DVDEND", from_date: "2026-01-01", to_date: "2026-06-30", limit: 5, offset: 10 },
      env,
    );

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("ticker")).toBe("FPH");
    expect(requestedUrl.searchParams.get("type")).toBe("DVDEND");
    expect(requestedUrl.searchParams.get("from")).toBe("2026-01-01");
    expect(requestedUrl.searchParams.get("to")).toBe("2026-06-30");
    expect(requestedUrl.searchParams.get("limit")).toBe("5");
    expect(requestedUrl.searchParams.get("offset")).toBe("10");
  });

  it("uses the upstream total for pagination metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 1 }], meta: { total: 42 } })));
    const env = await makeEnv();

    const result = await searchMarketAnnouncementsHandler({ ticker: "FPH", limit: 1 }, env);

    expect(result.structuredContent?.total_count).toBe(42);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(1);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 429, statusText: "Too Many Requests" })));
    const env = await makeEnv();

    const result = await searchMarketAnnouncementsHandler({ ticker: "FPH" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NZXplorer API returned HTTP 429");
  });
});
