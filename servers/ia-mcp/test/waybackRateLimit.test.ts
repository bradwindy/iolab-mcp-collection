import { afterEach, describe, expect, it, vi } from "vitest";
import { waybackFindNearestCaptureHandler } from "../src/tools/waybackFindNearestCapture.js";
import { waybackReadPageHandler } from "../src/tools/waybackReadPage.js";
import { waybackSearchCapturesHandler } from "../src/tools/waybackSearchCaptures.js";
import { fakeEnv } from "./support/fakeEnv.js";

function tooManyRequests(retryAfter?: string) {
  return new Response("rate limited", {
    status: 429,
    statusText: "Too Many Requests",
    headers: retryAfter ? { "retry-after": retryAfter } : {},
  });
}

function cdxResponse(rows: string[][]) {
  const body = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"], ...rows];
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function pageResponse(finalUrl: string, html: string) {
  const response = new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

const isWayback = (input: RequestInfo | URL) => input.toString().startsWith("https://web.archive.org/");

describe("Wayback rate limiting", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not retry a 429, and fails fast without calling upstream during the cooldown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tooManyRequests("120"));
    vi.stubGlobal("fetch", fetchMock);
    const env = fakeEnv();

    const first = await waybackSearchCapturesHandler({ url: "example.org" }, env);
    expect(first.isError).toBe(true);
    expect(first.content[0]?.text).toContain("Wait about 120 seconds");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await waybackSearchCapturesHandler({ url: "other.example.org" }, env);
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toContain("cooling down, request not sent");
    expect(second.content[0]?.text).toContain("ia_wayback_read_page");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches CDX lookups so a repeated query does not hit upstream again", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(cdxResponse([["k", "20150610000000", "https://example.org/", "text/html", "200", "A", "10"]])));
    vi.stubGlobal("fetch", fetchMock);
    const env = fakeEnv();

    await waybackSearchCapturesHandler({ url: "example.org" }, env);
    const again = await waybackSearchCapturesHandler({ url: "example.org" }, env);

    expect(again.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("read_page falls back to another archive on a 429, and says so", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (isWayback(input)) return Promise.resolve(tooManyRequests());
      return Promise.resolve(
        pageResponse(
          "https://arquivo.pt/wayback/20150301000000id_/https://example.org/",
          "<html><body><h1>From Arquivo</h1></body></html>",
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await waybackReadPageHandler({ url: "https://example.org/", timestamp: "20150101" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.source_archive).toBe("Arquivo.pt");
    expect(result.structuredContent?.actual_timestamp).toBe("20150301000000");
    expect(result.structuredContent?.archived_url).toBe(
      "https://arquivo.pt/wayback/20150301000000/https://example.org/",
    );
    expect(result.structuredContent?.notice).toContain("rate-limiting");
    expect(result.structuredContent?.content).toContain("From Arquivo");
  });

  it("read_page keeps the original Wayback error when no other archive has the page", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(isWayback(input) ? tooManyRequests() : new Response("not found", { status: 404 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await waybackReadPageHandler({ url: "https://example.org/" }, fakeEnv());

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Wayback Machine returned HTTP 429");
  });

  it("find_nearest_capture falls back to another archive's closest capture on a 429", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (isWayback(input)) return Promise.resolve(tooManyRequests());
      return Promise.resolve(pageResponse("https://arquivo.pt/wayback/20150620000000id_/https://example.org/", "<html></html>"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await waybackFindNearestCaptureHandler({ url: "https://example.org/", target_date: "20150615" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.source_archive).toBe("Arquivo.pt");
    expect(result.structuredContent?.closest).toBe("after");
    expect(result.structuredContent?.nearest_before).toBeNull();
    expect(result.structuredContent?.nearest_after).toMatchObject({
      timestamp: "20150620000000",
      archived_url: "https://arquivo.pt/wayback/20150620000000/https://example.org/",
      days_from_target: 5,
    });
  });

  it("routes Wayback through the home proxy when configured, following redirects with the key", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.host).toBe("wayback.example.com");
      expect(new Headers(init?.headers).get("X-Wayback-Key")).toBe("sekrit");
      expect(init?.redirect).toBe("manual");
      if (url.pathname === "/web/20150101id_/https://example.org/") {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/web/20141231120000id_/https://example.org/" } }));
      }
      return Promise.resolve(new Response("<html><body><h1>Via home</h1></body></html>", { status: 200, headers: { "content-type": "text/html" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = { ...fakeEnv(), WAYBACK_PROXY_URL: "https://wayback.example.com", WAYBACK_PROXY_KEY: "sekrit" } as Env;

    const result = await waybackReadPageHandler({ url: "https://example.org/", timestamp: "20150101" }, env);

    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.structuredContent?.source_archive).toBe("Internet Archive Wayback Machine");
    expect(result.structuredContent?.actual_timestamp).toBe("20141231120000");
    expect(result.structuredContent?.content).toContain("Via home");
  });

  it("puts the proxy's own 429 into the same cooldown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("rate limited by wayback-proxy", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "x-wayback-proxy": "rate-limited", "retry-after": "5" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = { ...fakeEnv(), WAYBACK_PROXY_URL: "https://wayback.example.com", WAYBACK_PROXY_KEY: "sekrit" } as Env;

    await waybackSearchCapturesHandler({ url: "example.org" }, env);
    const second = await waybackSearchCapturesHandler({ url: "other.example.org" }, env);

    expect(second.content[0]?.text).toContain("cooling down, request not sent");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
