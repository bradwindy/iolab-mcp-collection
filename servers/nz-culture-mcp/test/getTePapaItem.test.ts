import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey, setCredential } from "@iolab/credentials";
import { getTePapaItemHandler } from "../src/tools/getTePapaItem.js";
import { SERVER_SLUG, TE_PAPA_API_KEY } from "../src/constants.js";
import { createFakeCredentialsDb } from "./fakeCredentialsDb.js";

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

const SAMPLE_OBJECT = {
  id: 64660,
  type: "Object",
  collection: "TaongaMaori",
  collectionLabel: "Taonga Maori",
  title: "Kahu kiwi (kiwi feather cloak)",
  hasRepresentation: [
    {
      id: 277437,
      type: "ImageObject",
      thumbnailUrl: "https://media.tepapa.govt.nz/collection/277437/thumb",
    },
  ],
  pid: "tepapa:collection/object/64660",
  iri: "http://tepapa.govt.nz/collection/object/64660",
  href: "https://data.tepapa.govt.nz/collection/object/64660",
  rightsHolder: "Museum of New Zealand Te Papa Tongarewa",
  accessRights: "https://www.tepapa.govt.nz/api-terms-of-use",
};

function tePapaItemResponse(record: unknown) {
  return new Response(JSON.stringify(record), { status: 200, headers: { "content-type": "application/json" } });
}

async function fakeEnv(apiKey: string | null): Promise<Env> {
  const CREDENTIALS_DB = createFakeCredentialsDb();
  const ENCRYPTION_KEY = generateEncryptionKey();
  if (apiKey) {
    await setCredential(CREDENTIALS_DB, SERVER_SLUG, TE_PAPA_API_KEY, apiKey, ENCRYPTION_KEY);
  }
  return { CREDENTIALS_DB, ENCRYPTION_KEY, MCP_CACHE: createFakeCache() } as unknown as Env;
}

describe("nz_culture_get_te_papa_item", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when the Te Papa API key is not configured", async () => {
    const env = await fakeEnv(null);

    const result = await getTePapaItemHandler({ resource_type: "object", id: 64660 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("TE_PAPA_API_KEY");
  });

  it("fetches /collection/{resource_type}/{id} with the decrypted key", async () => {
    const env = await fakeEnv("guest-key-123");
    const fetchMock = vi.fn().mockResolvedValue(tePapaItemResponse(SAMPLE_OBJECT));
    vi.stubGlobal("fetch", fetchMock);

    await getTePapaItemHandler({ resource_type: "object", id: 64660 }, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.toString()).toBe("https://data.tepapa.govt.nz/collection/object/64660");
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("guest-key-123");
  });

  it("returns a concise summary with the first representation's thumbnail by default", async () => {
    const env = await fakeEnv("guest-key-123");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tePapaItemResponse(SAMPLE_OBJECT)));

    const result = await getTePapaItemHandler({ resource_type: "object", id: 64660 }, env);

    expect(result.structuredContent).toMatchObject({
      id: 64660,
      type: "Object",
      title: "Kahu kiwi (kiwi feather cloak)",
      collection: "Taonga Maori",
      thumbnail_url: "https://media.tepapa.govt.nz/collection/277437/thumb",
    });
    expect(result.structuredContent?.record).toBeUndefined();
  });

  it("includes the full raw record in detailed format", async () => {
    const env = await fakeEnv("guest-key-123");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tePapaItemResponse(SAMPLE_OBJECT)));

    const result = await getTePapaItemHandler({ resource_type: "object", id: 64660, response_format: "detailed" }, env);

    const record = result.structuredContent?.record as Record<string, unknown>;
    expect(record?.hasRepresentation).toBeDefined();
  });

  it("caches the upstream fetch across calls for the same resource_type/id", async () => {
    const env = await fakeEnv("guest-key-123");
    const fetchMock = vi.fn().mockResolvedValue(tePapaItemResponse(SAMPLE_OBJECT));
    vi.stubGlobal("fetch", fetchMock);

    await getTePapaItemHandler({ resource_type: "object", id: 64660 }, env);
    await getTePapaItemHandler({ resource_type: "object", id: 64660, response_format: "detailed" }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    const env = await fakeEnv("guest-key-123");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404, statusText: "Not Found" })));

    const result = await getTePapaItemHandler({ resource_type: "object", id: 999999 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Te Papa Collections API returned HTTP 404");
  });
});
