import { afterEach, describe, expect, it, vi } from "vitest";
import { waybackFindNearestCaptureHandler } from "../src/tools/waybackFindNearestCapture.js";
import { fakeEnv } from "./support/fakeEnv.js";

function cdxResponse(rows: string[][]) {
  const body = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"], ...rows];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ia_wayback_find_nearest_capture", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns both the nearest-before and nearest-after capture, and picks the closer one", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      // to=<target>&limit=-1 -> nearest before; from=<target>&limit=1 -> nearest after.
      if (url.searchParams.get("limit") === "-1") {
        return Promise.resolve(cdxResponse([["k", "20150610000000", "https://example.org/", "text/html", "200", "B", "10"]]));
      }
      return Promise.resolve(cdxResponse([["k", "20150620000000", "https://example.org/", "text/html", "200", "A", "10"]]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await waybackFindNearestCaptureHandler({ url: "https://example.org/", target_date: "20150615" }, fakeEnv());

    expect(result.structuredContent?.nearest_before).toMatchObject({ timestamp: "20150610000000" });
    expect(result.structuredContent?.nearest_after).toMatchObject({ timestamp: "20150620000000" });
    // Both are 5 days from the target — before wins the tie per the handler's <=.
    expect(result.structuredContent?.closest).toBe("before");
  });

  it("falls back to whichever side exists when the other has no captures", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.searchParams.get("limit") === "-1") {
        return Promise.resolve(cdxResponse([["k", "20150610000000", "https://example.org/", "text/html", "200", "B", "10"]]));
      }
      return Promise.resolve(cdxResponse([]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await waybackFindNearestCaptureHandler({ url: "https://example.org/", target_date: "20150615" }, fakeEnv());

    expect(result.structuredContent?.nearest_after).toBeNull();
    expect(result.structuredContent?.closest).toBe("before");
  });
});
