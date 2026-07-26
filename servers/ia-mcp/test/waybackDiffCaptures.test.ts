import { afterEach, describe, expect, it, vi } from "vitest";
import { waybackDiffCapturesHandler } from "../src/tools/waybackDiffCaptures.js";
import { fakeEnv } from "./support/fakeEnv.js";

function cdxResponse(rows: string[][]) {
  const body = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"], ...rows];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function pageResponse(finalUrl: string, html: string) {
  const response = new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

describe("ia_wayback_diff_captures", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("short-circuits with no page fetch when both captures share the same CDX digest", async () => {
    // mockImplementation (not mockResolvedValue) so each call gets a fresh Response — the two
    // digest lookups run concurrently via Promise.all, and a Response body can only be read once.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(cdxResponse([["k", "20200101000000", "https://example.org/", "text/html", "200", "SAME", "10"]])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await waybackDiffCapturesHandler(
      { url: "https://example.org/", timestamp_a: "20200101000000", timestamp_b: "20210101000000" },
      fakeEnv(),
    );

    expect(result.structuredContent?.identical).toBe(true);
    // Only the two cheap CDX digest lookups — no page fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns added/removed lines when digests differ", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/cdx/search/cdx")) {
        const digest = url.includes("20200101000000") ? "OLD" : "NEW";
        return Promise.resolve(cdxResponse([["k", "20200101000000", "https://example.org/", "text/html", "200", digest, "10"]]));
      }
      if (url.includes("20200101000000id_")) {
        return Promise.resolve(pageResponse(url, "<p>Old content here</p>"));
      }
      return Promise.resolve(pageResponse(url, "<p>New content here</p>"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await waybackDiffCapturesHandler(
      { url: "https://example.org/", timestamp_a: "20200101000000", timestamp_b: "20210101000000" },
      fakeEnv(),
    );

    expect(result.structuredContent?.identical).toBe(false);
    expect(result.structuredContent?.diff as string).toContain("- Old content here");
    expect(result.structuredContent?.diff as string).toContain("+ New content here");
  });
});
