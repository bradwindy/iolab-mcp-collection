import { afterEach, describe, expect, it, vi } from "vitest";
import { getTideForecastHandler } from "../src/tools/getTideForecast.js";
import { createFakeEnv } from "./testEnv.js";

function tideResponse(values: Array<{ time: string; value: number }>) {
  return new Response(JSON.stringify({ values }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("nz_env_get_tide_forecast", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no NIWA key is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv();

    const result = await getTideForecastHandler({ lat: -36.8485, long: 174.7633 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NIWA_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the API key via the x-apikey header and maps values to tides", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      tideResponse([
        { time: "2026-07-10T02:00:00Z", value: 1.8 },
        { time: "2026-07-10T08:00:00Z", value: 0.3 },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getTideForecastHandler({ lat: -36.8485, long: 174.7633 }, env);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.tides).toEqual([
      { time: "2026-07-10T02:00:00Z", height_m: 1.8 },
      { time: "2026-07-10T08:00:00Z", height_m: 0.3 },
    ]);

    const [requestedUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(requestedUrl).pathname).toBe("/tides/data");
    expect((requestInit.headers as Record<string, string>)["x-apikey"]).toBe("secret-niwa-key");
    expect(new URL(requestedUrl).searchParams.has("apikey")).toBe(false);
  });

  it("passes numberOfDays, startDate, and datum through as query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tideResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    await getTideForecastHandler({ lat: -36.8485, long: 174.7633, days: 5, start_date: "2026-07-15", datum: "MSL" }, env);

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("numberOfDays")).toBe("5");
    expect(requestedUrl.searchParams.get("startDate")).toBe("2026-07-15");
    expect(requestedUrl.searchParams.get("datum")).toBe("MSL");
  });

  it("never returns the upstream API key to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tideResponse([])));
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getTideForecastHandler({ lat: -36.8485, long: 174.7633 }, env);

    expect(result.structuredContent).not.toHaveProperty("chart_url");
    expect(JSON.stringify(result)).not.toContain("secret-niwa-key");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 429, statusText: "Too Many Requests" })));
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getTideForecastHandler({ lat: -36.8485, long: 174.7633 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NIWA Tide Forecasting API returned HTTP 429");
  });
});
