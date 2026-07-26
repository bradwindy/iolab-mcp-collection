import { afterEach, describe, expect, it, vi } from "vitest";
import { waybackListSiteUrlsHandler } from "../src/tools/waybackListSiteUrls.js";
import { fakeEnv } from "./support/fakeEnv.js";

function cdxResponse(rows: string[][]) {
  const body = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"], ...rows];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ia_wayback_list_site_urls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("excludes URLs whose most recent capture 4xx/5xx'd by default", async () => {
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

  it("keeps each URL's MOST RECENT capture when the same URL was captured multiple times", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        cdxResponse([
          ["k", "20180101000000", "https://example.org/page", "text/html", "200", "OLD", "10"],
          ["k", "20220101000000", "https://example.org/page", "text/html", "200", "NEW", "10"],
        ]),
      ),
    );

    const result = await waybackListSiteUrlsHandler({ url: "example.org" }, fakeEnv());

    expect(result.structuredContent?.items).toEqual([
      { url: "https://example.org/page", last_seen: "2022-01-01T00:00:00Z", last_status: "200" },
    ]);
  });
});
