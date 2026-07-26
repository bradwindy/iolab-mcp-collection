import { afterEach, describe, expect, it, vi } from "vitest";
import { waybackSearchCapturesHandler } from "../src/tools/waybackSearchCaptures.js";
import { fakeEnv } from "./support/fakeEnv.js";

function cdxResponse(rows: string[][]) {
  const body = [
    ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
    ...rows,
  ];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ia_wayback_search_captures", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns captures with a ready-to-use archived_url and iso_date", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        cdxResponse([
          ["org,example)/", "20200101000000", "https://example.org/", "text/html", "200", "ABC123", "1024"],
        ]),
      ),
    );

    const result = await waybackSearchCapturesHandler({ url: "https://example.org/" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.items).toEqual([
      {
        timestamp: "20200101000000",
        iso_date: "2020-01-01T00:00:00Z",
        original: "https://example.org/",
        mimetype: "text/html",
        statuscode: "200",
        digest: "ABC123",
        length: "1024",
        archived_url: "https://web.archive.org/web/20200101000000/https://example.org/",
      },
    ]);
  });

  it("surfaces a CDX 503 as an actionable upstream error, per the throttling confirmed live", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" })),
    );

    const result = await waybackSearchCapturesHandler({ url: "https://example.org/" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("503");
  });

  it("reports has_more and next_offset correctly when more captures exist", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => [
      "org,example)/",
      `2020010${i + 1}000000`,
      "https://example.org/",
      "text/html",
      "200",
      `DIGEST${i}`,
      "1024",
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cdxResponse(rows)));

    // limit=2 but 3 rows returned (the +1 has-more probe) -> has_more true
    const result = await waybackSearchCapturesHandler({ url: "https://example.org/", limit: 2 }, fakeEnv());

    expect(result.structuredContent?.items).toHaveLength(2);
    expect(result.structuredContent?.has_more).toBe(true);
    expect(result.structuredContent?.next_offset).toBe(2);
  });

  it("appends multiple CDX filter params rather than overwriting one with the other", async () => {
    const fetchMock = vi.fn().mockResolvedValue(cdxResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await waybackSearchCapturesHandler(
      { url: "https://example.org/", status_filter: "200", mime_filter: "text/html" },
      fakeEnv(),
    );

    const requestedUrl = new URL((fetchMock.mock.calls[0]?.[0] as Request | string | URL).toString());
    expect(requestedUrl.searchParams.getAll("filter")).toEqual(["statuscode:200", "mimetype:text/html"]);
  });
});
