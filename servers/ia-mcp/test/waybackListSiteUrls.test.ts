import { afterEach, describe, expect, it, vi } from "vitest";
import { waybackListSiteUrlsHandler } from "../src/tools/waybackListSiteUrls.js";
import { fakeEnv } from "./support/fakeEnv.js";

function cdxResponse(rows: string[][]) {
  const body = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"], ...rows];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ia_wayback_list_site_urls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests server-side collapse=urlkey, not a raw uncollapsed scan", async () => {
    // Regression: a raw (uncollapsed) scan can be entirely dominated by one heavily-crawled URL
    // (confirmed live: trademe.co.nz's homepage alone filled ~130 of the first 150 raw CDX rows
    // for its 1999-2001 range), starving every other distinct URL out of a small fetch window —
    // returning only 1-2 URLs even though thousands exist. collapse=urlkey asks CDX itself for one
    // row per distinct URL, so the fetch budget maps directly to distinct-URL coverage instead.
    const fetchMock = vi.fn().mockResolvedValue(cdxResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await waybackListSiteUrlsHandler({ url: "example.org" }, fakeEnv());

    const requestedUrl = (fetchMock.mock.calls[0]?.[0] as { toString(): string } | string).toString();
    expect(requestedUrl).toContain("collapse=urlkey");
  });

  it("excludes URLs whose first capture in range 4xx/5xx'd by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        cdxResponse([
          ["k1", "20200101000000", "https://example.org/ok", "text/html", "200", "D1", "10"],
          ["k2", "20200101000000", "https://example.org/gone", "text/html", "404", "D2", "10"],
        ]),
      ),
    );

    const result = await waybackListSiteUrlsHandler({ url: "example.org" }, fakeEnv());

    const urls = (result.structuredContent?.items as Array<{ url: string }>).map((i) => i.url);
    expect(urls).toContain("https://example.org/ok");
    expect(urls).not.toContain("https://example.org/gone");
  });

  it("reports the collapsed row's own timestamp/status as first_seen/first_status", async () => {
    // Server-side collapse=urlkey always returns the FIRST (earliest) capture in a group, never
    // the most recent — confirmed live, and there is no server-side way to combine collapse with
    // "last capture per group." The field names must reflect that honestly.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        cdxResponse([["k", "19990101000000", "https://example.org/page", "text/html", "200", "D", "10"]]),
      ),
    );

    const result = await waybackListSiteUrlsHandler({ url: "example.org" }, fakeEnv());

    expect(result.structuredContent?.items).toEqual([
      { url: "https://example.org/page", first_seen: "1999-01-01T00:00:00Z", first_status: "200" },
    ]);
  });

  it("stops escalating and reports has_more:false instead of looping forever when every row is filtered out", async () => {
    // Regression: if exclude_errors filters out every fetched row and CDX still claims more exist,
    // a fixed-size fetch would return an empty page with has_more:true and an UNCHANGED
    // next_offset — a caller paging on it would repeat the exact same query forever. The handler
    // must escalate its raw fetch up to a hard cap, then give up and report has_more:false rather
    // than trap the caller in a non-advancing loop.
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const requestedLimit = Number(new URL(input.toString()).searchParams.get("limit"));
      // Always return exactly the requested amount, all 404s — CDX always "has more" from the
      // handler's point of view, and every row is filtered out by exclude_errors (the default).
      const rows = Array.from({ length: requestedLimit }, (_, i) => [
        `k${i}`,
        "20200101000000",
        `https://example.org/dead${i}`,
        "text/html",
        "404",
        `D${i}`,
        "10",
      ]);
      return Promise.resolve(cdxResponse(rows));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await waybackListSiteUrlsHandler({ url: "example.org" }, fakeEnv());

    expect(result.structuredContent?.items).toEqual([]);
    expect(result.structuredContent?.has_more).toBe(false);
    expect(result.structuredContent?.next_offset).toBeNull();
    expect(result.structuredContent?.notice).toContain("scan cap");
  });
});
