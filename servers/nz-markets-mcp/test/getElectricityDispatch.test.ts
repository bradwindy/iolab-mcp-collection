import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEncryptionKey, setCredential } from "@nz-mcp/credentials";
import { getElectricityDispatchHandler } from "../src/tools/getElectricityDispatch.js";
import { EA_DISPATCH_API_KEY, SERVER_SLUG } from "../src/constants.js";
import { createFakeCredentialsDb } from "./fakeCredentialsDb.js";
import { createFakeKv } from "./fakeKv.js";

const SAMPLE_RECORDS = [
  {
    PointOfConnectionCode: "ABY0111",
    FiveMinuteIntervalDatetime: "2026-07-09T17:00:00Z",
    FiveMinuteIntervalNumber: 1,
    RunDateTime: "2026-07-09T03:59:01Z",
    SPDLoadMegawatt: 2.613,
    SPDGenerationMegawatt: 0,
    DollarsPerMegawattHour: 112,
  },
  {
    PointOfConnectionCode: "HAY2201",
    FiveMinuteIntervalDatetime: "2026-07-09T17:00:00Z",
    FiveMinuteIntervalNumber: 1,
    RunDateTime: "2026-07-09T03:59:01Z",
    SPDLoadMegawatt: 0,
    SPDGenerationMegawatt: 50,
    DollarsPerMegawattHour: 95.5,
  },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function makeEnv() {
  const encryptionKey = generateEncryptionKey();
  const db = createFakeCredentialsDb();
  await setCredential(db, SERVER_SLUG, EA_DISPATCH_API_KEY, "test-dispatch-key", encryptionKey);
  return { CREDENTIALS_DB: db, ENCRYPTION_KEY: encryptionKey, MCP_CACHE: createFakeKv() } as unknown as Env;
}

describe("nz_markets_get_electricity_dispatch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no EA dispatch key is configured", async () => {
    const env = { CREDENTIALS_DB: createFakeCredentialsDb(), ENCRYPTION_KEY: generateEncryptionKey(), MCP_CACHE: createFakeKv() } as unknown as Env;

    const result = await getElectricityDispatchHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("EA_DISPATCH_API_KEY");
  });

  it("returns concise rows by default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SAMPLE_RECORDS)));
    const env = await makeEnv();

    const result = await getElectricityDispatchHandler({}, env);

    expect(result.structuredContent?.items).toEqual([
      { point_of_connection_code: "ABY0111", interval_datetime_nz: "2026-07-09T17:00:00Z", price_dollars_per_mwh: 112, generation_mw: 0, load_mw: 2.613 },
      { point_of_connection_code: "HAY2201", interval_datetime_nz: "2026-07-09T17:00:00Z", price_dollars_per_mwh: 95.5, generation_mw: 50, load_mw: 0 },
    ]);
  });

  it("includes interval number and UTC run time in detailed format", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SAMPLE_RECORDS)));
    const env = await makeEnv();

    const result = await getElectricityDispatchHandler({ response_format: "detailed" }, env);
    const item = (result.structuredContent?.items as Array<Record<string, unknown>>)[0];

    expect(item?.interval_number).toBe(1);
    expect(item?.run_datetime_utc).toBe("2026-07-09T03:59:01Z");
  });

  it("sends the Ocp-Apim-Subscription-Key header against the real-time-dispatch path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_RECORDS));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeEnv();

    await getElectricityDispatchHandler({}, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(requestedUrl.pathname).toBe("/real-time-dispatch/");
    expect((requestInit.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("test-dispatch-key");
  });

  it("builds an OData $filter combining point_of_connection_code and at_datetime", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_RECORDS));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeEnv();

    await getElectricityDispatchHandler({ point_of_connection_code: "HAY2201", at_datetime: "2026-07-09T17:00" }, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("$filter")).toBe(
      "PointOfConnectionCode eq 'HAY2201' and FiveMinuteIntervalDatetime eq datetime'2026-07-09T17:00'",
    );
  });

  it("caches results for the same filter combination instead of refetching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_RECORDS));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeEnv();

    await getElectricityDispatchHandler({ point_of_connection_code: "HAY2201" }, env);
    await getElectricityDispatchHandler({ point_of_connection_code: "HAY2201" }, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches for a different point_of_connection_code", async () => {
    // Each call must actually hit the (mocked) network, so the mock needs a fresh Response
    // per invocation — a Response body can only be read once, and mockResolvedValue would
    // otherwise hand back the same already-consumed instance on the second real fetch.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(SAMPLE_RECORDS)));
    vi.stubGlobal("fetch", fetchMock);
    const env = await makeEnv();

    await getElectricityDispatchHandler({ point_of_connection_code: "HAY2201" }, env);
    await getElectricityDispatchHandler({ point_of_connection_code: "ABY0111" }, env);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports pagination truncation via the notice field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(SAMPLE_RECORDS)));
    const env = await makeEnv();

    const result = await getElectricityDispatchHandler({ limit: 1 }, env);

    expect(result.structuredContent?.total_count).toBe(2);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.notice).toContain("Showing 1 of 2");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));
    const env = await makeEnv();

    const result = await getElectricityDispatchHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Electricity Authority EMI APIs returned HTTP 503");
  });
});
