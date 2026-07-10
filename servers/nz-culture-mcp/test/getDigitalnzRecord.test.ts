import { afterEach, describe, expect, it, vi } from "vitest";
import { getDigitalnzRecordHandler } from "../src/tools/getDigitalnzRecord.js";

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

const SAMPLE_RECORD = {
  id: 22065693,
  title: "Desert cantos : Richard Misrach",
  display_collection: "National Library of New Zealand Catalogue",
  display_content_partner: "National Library of New Zealand",
  category: ["Books"],
  dnz_type: "Book",
  display_date: "c1988.",
  date: ["1988-01-01T00:00:00.000Z"],
  rights: null,
  thumbnail_url: null,
  large_thumbnail_url: null,
  landing_url: "http://natlib.govt.nz/records/22065693",
  description: null,
  creator: ["Misrach, Richard, 1949-"],
  subject: ["Photography -- Southwest, New -- Landscapes -- Exhibitions"],
  tag: [],
  usage: ["All rights reserved"],
  copyright: ["All rights reserved"],
  language: ["eng"],
  is_commercial_use: null,
  source_url: null,
};

function digitalNzRecordResponse(record: unknown) {
  return new Response(JSON.stringify({ record }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("nz_culture_get_digitalnz_record", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns concise fields by default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(digitalNzRecordResponse(SAMPLE_RECORD)));
    const env = { MCP_CACHE: createFakeCache() } as unknown as Env;

    const result = await getDigitalnzRecordHandler({ record_id: 22065693 }, env);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.title).toBe("Desert cantos : Richard Misrach");
    expect(result.structuredContent?.creator).toBeUndefined();
  });

  it("includes creator/subject in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(digitalNzRecordResponse(SAMPLE_RECORD)));
    const env = { MCP_CACHE: createFakeCache() } as unknown as Env;

    const result = await getDigitalnzRecordHandler({ record_id: 22065693, response_format: "detailed" }, env);

    expect(result.structuredContent?.creator).toEqual(["Misrach, Richard, 1949-"]);
  });

  it("caches the upstream fetch across calls for the same id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(digitalNzRecordResponse(SAMPLE_RECORD));
    vi.stubGlobal("fetch", fetchMock);
    const env = { MCP_CACHE: createFakeCache() } as unknown as Env;

    await getDigitalnzRecordHandler({ record_id: 22065693 }, env);
    await getDigitalnzRecordHandler({ record_id: 22065693, response_format: "detailed" }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404, statusText: "Not Found" })));
    const env = { MCP_CACHE: createFakeCache() } as unknown as Env;

    const result = await getDigitalnzRecordHandler({ record_id: 999999999 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DigitalNZ returned HTTP 404");
  });
});
