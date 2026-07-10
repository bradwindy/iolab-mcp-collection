import { afterEach, describe, expect, it, vi } from "vitest";
import { getCo2LatestHandler } from "../src/tools/getCo2Latest.js";
import { createFakeEnv } from "./testEnv.js";

function textResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("nz_env_get_co2_latest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns an actionable error when no NIWA key is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv();

    const result = await getCo2LatestHandler({}, env);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("NIWA_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses 'key: value' style lines and preserves the raw text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("Latest: 424.7\nDate: 2026-07-08\n")));
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getCo2LatestHandler({}, env);

    expect(result.structuredContent?.parsed).toEqual({ Latest: "424.7", Date: "2026-07-08" });
    expect(result.structuredContent?.raw_text).toBe("Latest: 424.7\nDate: 2026-07-08\n");
  });

  it("parses NIWA's real pipe-delimited baringhead.txt format", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        textResponse("2026-07-08\nLatest daily average|424.7\nOne year ago|423.3\nOne decade ago|401.1\n"),
      ),
    );
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getCo2LatestHandler({}, env);

    expect(result.structuredContent?.parsed).toEqual({
      "Latest daily average": "424.7",
      "One year ago": "423.3",
      "One decade ago": "401.1",
    });
  });

  it("warns and leaves parsed empty when the text doesn't look like key/value lines", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("424.7 ppm as of 8 July 2026")));
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getCo2LatestHandler({}, env);

    expect(result.structuredContent?.parsed).toEqual({});
    expect(result.structuredContent?.notice).toContain("could not confirm");
    expect(result.structuredContent?.raw_text).toBe("424.7 ppm as of 8 July 2026");
  });

  it("sends the API key via the x-apikey header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse("Latest: 424.7"));
    vi.stubGlobal("fetch", fetchMock);
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    await getCo2LatestHandler({}, env);

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((requestInit.headers as Record<string, string>)["x-apikey"]).toBe("secret-niwa-key");
  });

  it("never returns the upstream API key to the caller", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse("Latest: 424.7")));
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getCo2LatestHandler({}, env);

    expect(result.structuredContent).not.toHaveProperty("chart_url");
    expect(JSON.stringify(result)).not.toContain("secret-niwa-key");
  });

  it("returns an actionable error on upstream HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 500, statusText: "Internal Server Error" })));
    const env = await createFakeEnv({ niwaApiKey: "secret-niwa-key" });

    const result = await getCo2LatestHandler({}, env);

    expect(result.isError).toBe(true);
  });
});
