import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey, setCredential } from "@iolab/credentials";
import { searchCompaniesHandler } from "../src/tools/searchCompanies.js";
import { NZXPLORER_API_KEY, SERVER_SLUG } from "../src/constants.js";
import { createFakeCredentialsDb } from "./fakeCredentialsDb.js";
import { createFakeKv } from "./fakeKv.js";

const SAMPLE_COMPANIES = [
  {
    id: 1,
    ticker: "FPH",
    name: "Fisher & Paykel Healthcare Corporation Limited",
    sector: "Healthcare",
    slug: "fph",
    market_cap: 15_000_000_000,
    website_url: "https://www.fphcare.com",
    isin: "NZFAPE0001S2",
    lei: null,
    exchange_mic: "XNZE",
  },
  {
    id: 2,
    ticker: "AIR",
    name: "Air New Zealand Limited",
    sector: "Industrials",
    slug: "air",
    market_cap: 2_000_000_000,
    website_url: null,
    isin: null,
    lei: null,
    exchange_mic: "XNZE",
  },
  {
    id: 3,
    ticker: "SPK",
    name: "Spark New Zealand Limited",
    sector: "Technology",
    slug: "spk",
    market_cap: 5_000_000_000,
    website_url: null,
    isin: null,
    lei: null,
    exchange_mic: "XNZE",
  },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function makeEnv() {
  const encryptionKey = generateEncryptionKey();
  const db = createFakeCredentialsDb();
  await setCredential(db, SERVER_SLUG, NZXPLORER_API_KEY, "test-key", encryptionKey);
  return { CREDENTIALS_DB: db, ENCRYPTION_KEY: encryptionKey, MCP_CACHE: createFakeKv() } as unknown as Env;
}

describe("nz_markets_search_companies", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no NZXplorer key is configured", async () => {
    const env = { CREDENTIALS_DB: createFakeCredentialsDb(), ENCRYPTION_KEY: generateEncryptionKey(), MCP_CACHE: createFakeKv() } as unknown as Env;

    const result = await searchCompaniesHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NZXPLORER_API_KEY");
  });

  it("returns concise company summaries by default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: SAMPLE_COMPANIES, meta: { total: 3 } })));
    const env = await makeEnv();

    const result = await searchCompaniesHandler({}, env);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.total_count).toBe(3);
    expect(result.structuredContent?.items).toEqual([
      { ticker: "FPH", name: "Fisher & Paykel Healthcare Corporation Limited", sector: "Healthcare", market_cap_nzd: 15_000_000_000 },
      { ticker: "AIR", name: "Air New Zealand Limited", sector: "Industrials", market_cap_nzd: 2_000_000_000 },
      { ticker: "SPK", name: "Spark New Zealand Limited", sector: "Technology", market_cap_nzd: 5_000_000_000 },
    ]);
  });

  it("filters by query against name or ticker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: SAMPLE_COMPANIES, meta: { total: 3 } })));
    const env = await makeEnv();

    const result = await searchCompaniesHandler({ query: "fisher" }, env);

    expect(result.structuredContent?.total_count).toBe(1);
    expect((result.structuredContent?.items as Array<Record<string, unknown>>)[0]?.ticker).toBe("FPH");
  });

  it("filters by sector client-side", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: SAMPLE_COMPANIES, meta: { total: 3 } })));
    const env = await makeEnv();

    const result = await searchCompaniesHandler({ sector: "Technology" }, env);

    expect(result.structuredContent?.total_count).toBe(1);
    expect((result.structuredContent?.items as Array<Record<string, unknown>>)[0]?.ticker).toBe("SPK");
  });

  it("includes identifiers in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: SAMPLE_COMPANIES, meta: { total: 3 } })));
    const env = await makeEnv();

    const result = await searchCompaniesHandler({ query: "FPH", response_format: "detailed" }, env);
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.isin).toBe("NZFAPE0001S2");
    expect(item?.exchange_mic).toBe("XNZE");
  });

  it("sends the X-API-Key header and fetches the whole roster in one page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: SAMPLE_COMPANIES, meta: { total: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeEnv();

    await searchCompaniesHandler({}, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(requestedUrl.searchParams.get("limit")).toBe("500");
    expect((requestInit.headers as Record<string, string>)["X-API-Key"]).toBe("test-key");
  });

  it("caches the company roster across calls instead of refetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: SAMPLE_COMPANIES, meta: { total: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeEnv();

    await searchCompaniesHandler({}, env);
    await searchCompaniesHandler({ query: "air" }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));
    const env = await makeEnv();

    const result = await searchCompaniesHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NZXplorer API returned HTTP 503");
  });
});
