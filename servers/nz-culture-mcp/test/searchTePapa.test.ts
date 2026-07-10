import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey, setCredential } from "@nz-mcp/credentials";
import { searchTePapaHandler } from "../src/tools/searchTePapa.js";
import { SERVER_SLUG, TE_PAPA_API_KEY } from "../src/constants.js";
import { createFakeCredentialsDb } from "./fakeCredentialsDb.js";

const SAMPLE_TAXON = {
  id: 7320,
  type: "Taxon",
  title: "Little Spotted Kiwi, Apteryx owenii",
  prefLabel: "Apteryx owenii",
  scientificName: "Apteryx owenii",
  collectionLabel: undefined,
  pid: "tepapa:collection/taxon/7320",
  iri: "http://tepapa.govt.nz/collection/taxon/7320",
  href: "https://data.tepapa.govt.nz/collection/taxon/7320",
  rightsHolder: "Museum of New Zealand Te Papa Tongarewa",
  accessRights: "https://www.tepapa.govt.nz/api-terms-of-use",
};

function tePapaSearchResponse(results: unknown[], count: number, from = 0, size = results.length) {
  return new Response(JSON.stringify({ results, facets: {}, _metadata: { resultset: { count, from, size, truncated: false } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function fakeEnv(apiKey: string | null): Promise<Env> {
  const CREDENTIALS_DB = createFakeCredentialsDb();
  const ENCRYPTION_KEY = generateEncryptionKey();
  if (apiKey) {
    await setCredential(CREDENTIALS_DB, SERVER_SLUG, TE_PAPA_API_KEY, apiKey, ENCRYPTION_KEY);
  }
  return { CREDENTIALS_DB, ENCRYPTION_KEY } as unknown as Env;
}

describe("nz_culture_search_te_papa", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when the Te Papa API key is not configured", async () => {
    const env = await fakeEnv(null);

    const result = await searchTePapaHandler({ query: "kiwi" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("TE_PAPA_API_KEY");
    expect(result.content[0]?.text).toContain("nz-culture-mcp");
  });

  it("sends the decrypted credential as the x-api-key header", async () => {
    const env = await fakeEnv("guest-key-123");
    const fetchMock = vi.fn().mockResolvedValue(tePapaSearchResponse([SAMPLE_TAXON], 1));
    vi.stubGlobal("fetch", fetchMock);

    await searchTePapaHandler({ query: "kiwi" }, env);

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("guest-key-123");
  });

  it("returns concise results by default", async () => {
    const env = await fakeEnv("guest-key-123");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tePapaSearchResponse([SAMPLE_TAXON], 1)));

    const result = await searchTePapaHandler({ query: "kiwi" }, env);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.items).toEqual([
      {
        id: 7320,
        type: "Taxon",
        title: "Little Spotted Kiwi, Apteryx owenii",
        collection: null,
        url: "https://data.tepapa.govt.nz/collection/taxon/7320",
        rights_holder: "Museum of New Zealand Te Papa Tongarewa",
        thumbnail_url: null,
      },
    ]);
    expect(result.structuredContent?.total_count).toBe(1);
  });

  it("returns the full raw record in detailed format", async () => {
    const env = await fakeEnv("guest-key-123");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tePapaSearchResponse([SAMPLE_TAXON], 1)));

    const result = await searchTePapaHandler({ query: "kiwi", response_format: "detailed" }, env);

    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];
    expect(item?.scientificName).toBe("Apteryx owenii");
  });

  it("applies the collection filter as a type: query clause, aliasing Agent to Person/Organisation", async () => {
    const env = await fakeEnv("guest-key-123");
    const fetchMock = vi.fn().mockResolvedValue(tePapaSearchResponse([], 0));
    vi.stubGlobal("fetch", fetchMock);

    await searchTePapaHandler({ query: "kiwi", collection: "Agent" }, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("q")).toBe("kiwi AND (type:Person OR type:Organisation)");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    const env = await fakeEnv("guest-key-123");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 401, statusText: "Unauthorized" })));

    const result = await searchTePapaHandler({ query: "kiwi" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Te Papa Collections API returned HTTP 401");
  });
});
