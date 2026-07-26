import { afterEach, describe, expect, it, vi } from "vitest";
import { waybackGetCaptureTimelineHandler } from "../src/tools/waybackGetCaptureTimeline.js";
import { fakeEnv } from "./support/fakeEnv.js";

function cdxResponse(rows: string[][]) {
  const body = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"], ...rows];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ia_wayback_get_capture_timeline", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("summarises first/last capture, per-year counts, and distinct content versions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        cdxResponse([
          ["k", "20180601000000", "https://example.org/", "text/html", "200", "D1", "10"],
          ["k", "20190601000000", "https://example.org/", "text/html", "200", "D1", "10"], // same digest — not a new version
          ["k", "20200601000000", "https://example.org/", "text/html", "200", "D2", "10"],
        ]),
      ),
    );

    const result = await waybackGetCaptureTimelineHandler({ url: "https://example.org/" }, fakeEnv());

    expect(result.structuredContent?.first_capture).toEqual({ timestamp: "20180601000000", iso_date: "2018-06-01T00:00:00Z" });
    expect(result.structuredContent?.last_capture).toEqual({ timestamp: "20200601000000", iso_date: "2020-06-01T00:00:00Z" });
    expect(result.structuredContent?.captures_per_year).toEqual({ "2018": 1, "2019": 1, "2020": 1 });
    expect(result.structuredContent?.distinct_content_versions).toBe(2);
  });

  it("returns an empty-but-valid result when no captures exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cdxResponse([])));

    const result = await waybackGetCaptureTimelineHandler({ url: "https://never-archived.example/" }, fakeEnv());

    expect(result.structuredContent?.first_capture).toBeNull();
    expect(result.structuredContent?.total_captures_analysed).toBe(0);
  });
});
