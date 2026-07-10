import { afterEach, describe, expect, it, vi } from "vitest";
import { getUvForecastHandler } from "../src/tools/getUvForecast.js";
import { createFakeEnv } from "./testEnv.js";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("nz_env_get_uv_forecast", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no NIWA key is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv();

    const result = await getUvForecastHandler({ lat: -41.2865, long: 174.7762 }, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NIWA_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts a recognised 'values' series without a fallback notice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ values: [{ time: "2026-07-10T12:00:00Z", index: 6.2 }] })),
    );
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getUvForecastHandler({ lat: -41.2865, long: 174.7762 }, env);

    expect(result.structuredContent?.forecast).toEqual([{ time: "2026-07-10T12:00:00Z", index: 6.2 }]);
    expect(result.structuredContent?.notice).toBe("");
  });

  it("falls back to the raw payload and warns when the shape is unrecognised", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ somethingUnexpected: true })));
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getUvForecastHandler({ lat: -41.2865, long: 174.7762 }, env);

    const forecast = result.structuredContent?.forecast as Array<Record<string, unknown>>;
    expect(forecast[0]?.raw_response).toEqual({ somethingUnexpected: true });
    expect(result.structuredContent?.notice).toContain("could not confirm");
  });

  it("sends the API key via the x-apikey header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ values: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    await getUvForecastHandler({ lat: -41.2865, long: 174.7762 }, env);

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>)["x-apikey"]).toBe("secret-niwa-key");
  });

  it("never returns the upstream API key to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ values: [] })));
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getUvForecastHandler({ lat: -41.2865, long: 174.7762 }, env);

    expect(result.structuredContent).not.toHaveProperty("image_urls");
    expect(JSON.stringify(result)).not.toContain("secret-niwa-key");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503, statusText: "Service Unavailable" })));
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getUvForecastHandler({ lat: -41.2865, long: 174.7762 }, env);

    expect(result.isError).toBe(true);
  });
});
