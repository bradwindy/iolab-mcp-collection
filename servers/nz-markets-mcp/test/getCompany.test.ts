import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey, setCredential } from "@nz-mcp/credentials";
import { getCompanyHandler } from "../src/tools/getCompany.js";
import { NZXPLORER_API_KEY, SERVER_SLUG } from "../src/constants.js";
import { createFakeCredentialsDb } from "./fakeCredentialsDb.js";
import { createFakeKv } from "./fakeKv.js";

const SAMPLE_COMPANY_DATA = {
  ticker: "FPH",
  name: "Fisher & Paykel Healthcare Corporation Limited",
  sector: "Healthcare",
  slug: "fph",
  market_cap: 15_000_000_000,
  website_url: "https://www.fphcare.com",
  isin: "NZFAPE0001S2",
  lei: null,
  exchange_mic: "XNZE",
  governance: { total_score: 82 },
  directors: [{ name: "Someone" }],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function makeEnv() {
  const encryptionKey = generateEncryptionKey();
  const db = createFakeCredentialsDb();
  await setCredential(db, SERVER_SLUG, NZXPLORER_API_KEY, "test-key", encryptionKey);
  return { CREDENTIALS_DB: db, ENCRYPTION_KEY: encryptionKey, MCP_CACHE: createFakeKv() } as unknown as Env;
}

describe("nz_markets_get_company", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no NZXplorer key is configured", async () => {
    const env = { CREDENTIALS_DB: createFakeCredentialsDb(), ENCRYPTION_KEY: generateEncryptionKey(), MCP_CACHE: createFakeKv() } as unknown as Env;

    const result = await getCompanyHandler({ ticker: "FPH" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NZXPLORER_API_KEY");
  });

  it("returns known fields only in concise format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: SAMPLE_COMPANY_DATA, meta: {} })));
    const env = await makeEnv();

    const result = await getCompanyHandler({ ticker: "fph" }, env);

    expect(result.structuredContent?.ticker).toBe("FPH");
    expect(result.structuredContent?.sector).toBe("Healthcare");
    expect(result.structuredContent?.raw).toBeUndefined();
  });

  it("includes the raw upstream extras in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: SAMPLE_COMPANY_DATA, meta: {} })));
    const env = await makeEnv();

    const result = await getCompanyHandler({ ticker: "FPH", response_format: "detailed" }, env);

    expect(result.structuredContent?.raw).toMatchObject({ governance: { total_score: 82 } });
  });

  it("uppercases the ticker before calling upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: SAMPLE_COMPANY_DATA, meta: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeEnv();

    await getCompanyHandler({ ticker: "fph" }, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.pathname).toContain("/companies/FPH");
  });

  it("returns an actionable error with a search hint on a 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404, statusText: "Not Found" })));
    const env = await makeEnv();

    const result = await getCompanyHandler({ ticker: "ZZZ" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("nz_markets_search_companies");
  });
});
