import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey, setCredential } from "@nz-mcp/credentials";
import { searchIcpConnectionsHandler } from "../src/tools/searchIcpConnections.js";
import { EA_ICP_API_KEY, SERVER_SLUG } from "../src/constants.js";
import { createFakeCredentialsDb } from "./fakeCredentialsDb.js";
import { createFakeKv } from "./fakeKv.js";

const SAMPLE_ADDRESS = {
  PropertyNameOrDescription: null,
  PhysicalAddressUnit: null,
  PhysicalAddressNumber: "12",
  PhysicalAddressStreet: "Queen Street",
  PhysicalAddressSuburb: "Auckland Central",
  PhysicalAddressTown: "Auckland",
  PhysicalAddressRegion: "Auckland",
  PhysicalAddressPostCode: 1010,
  GPS_Easting: 0.1,
  GPS_Northing: 0.2,
};

const SAMPLE_ICP_DETAILS = {
  ICPIdentifier: "0000123456ZZAF0",
  ICPStatus: 1,
  Address: SAMPLE_ADDRESS,
  Network: { NetworkParticipantID: "ABC" },
  Pricing: { DistributorPriceCategoryCode: "X" },
  Trader: { TraderParticipantID: "XYZ" },
  Metering: { MeteringEquipmentProviderParticipantID: "M1" },
  Messages: [],
};

const SAMPLE_SEARCH_HIT = {
  Address: SAMPLE_ADDRESS,
  ICPIdentifier: "1234567890AA111",
  ICPStatus: 1,
  Messages: [],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function makeEnv() {
  const encryptionKey = generateEncryptionKey();
  const db = createFakeCredentialsDb();
  await setCredential(db, SERVER_SLUG, EA_ICP_API_KEY, "test-icp-key", encryptionKey);
  return { CREDENTIALS_DB: db, ENCRYPTION_KEY: encryptionKey, MCP_CACHE: createFakeKv() } as unknown as Env;
}

describe("nz_markets_search_icp_connections", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no EA ICP key is configured", async () => {
    const env = { CREDENTIALS_DB: createFakeCredentialsDb(), ENCRYPTION_KEY: generateEncryptionKey(), MCP_CACHE: createFakeKv() } as unknown as Env;

    const result = await searchIcpConnectionsHandler({ address_or_icp: "0000123456ZZAF0" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("EA_ICP_API_KEY");
  });

  it("calls the get-by-id endpoint for a valid ICP identifier", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_ICP_DETAILS));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeEnv();

    const result = await searchIcpConnectionsHandler({ address_or_icp: "0000123456zzaf0" }, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.pathname).toBe("/ICPConnectionData/v2/single/");
    expect(requestedUrl.searchParams.get("ICP")).toBe("0000123456ZZAF0");
    expect(result.structuredContent?.total_count).toBe(1);
  });

  it("parses a free-text address and calls the search endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([SAMPLE_SEARCH_HIT]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeEnv();

    await searchIcpConnectionsHandler({ address_or_icp: "12 Queen Street, Auckland Central, Auckland" }, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.pathname).toBe("/ICPConnectionData/v2/search/");
    expect(requestedUrl.searchParams.get("streetNumber")).toBe("12");
    expect(requestedUrl.searchParams.get("streetName")).toBe("Queen Street");
    expect(requestedUrl.searchParams.get("suburbOrTown")).toBe("Auckland Central");
    expect(requestedUrl.searchParams.get("region")).toBe("Auckland");
  });

  it("rejects an address with no discernible street number", async () => {
    const env = await makeEnv();

    const result = await searchIcpConnectionsHandler({ address_or_icp: "Queen Street" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("street number");
  });

  it("normalizes a single-object search response into a one-item array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SAMPLE_SEARCH_HIT)));
    const env = await makeEnv();

    const result = await searchIcpConnectionsHandler({ address_or_icp: "12 Queen Street" }, env);

    expect(result.structuredContent?.total_count).toBe(1);
    expect((result.structuredContent?.items as Array<Record<string, unknown>>)[0]?.icp_identifier).toBe("1234567890AA111");
  });

  it("returns an address summary in concise format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SAMPLE_ICP_DETAILS)));
    const env = await makeEnv();

    const result = await searchIcpConnectionsHandler({ address_or_icp: "0000123456ZZAF0" }, env);
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.address).toEqual({
      line1: "12 Queen Street",
      suburb: "Auckland Central",
      town: "Auckland",
      region: "Auckland",
      post_code: 1010,
    });
  });

  it("includes network/pricing/trader/metering in detailed format for a get-by-id result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SAMPLE_ICP_DETAILS)));
    const env = await makeEnv();

    const result = await searchIcpConnectionsHandler({ address_or_icp: "0000123456ZZAF0", response_format: "detailed" }, env);
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.network).toEqual({ NetworkParticipantID: "ABC" });
    expect(item?.trader).toEqual({ TraderParticipantID: "XYZ" });
  });

  it("notes the address-search field limitation for address-derived results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([SAMPLE_SEARCH_HIT])));
    const env = await makeEnv();

    const result = await searchIcpConnectionsHandler({ address_or_icp: "12 Queen Street" }, env);

    expect(result.structuredContent?.notice).toContain("exact ICP number");
  });

  it("returns an actionable error with a search hint on a 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "not found" }), { status: 404, statusText: "Not Found" })));
    const env = await makeEnv();

    const result = await searchIcpConnectionsHandler({ address_or_icp: "0000123456ZZAF0" }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Double-check the 15-character code");
  });
});
