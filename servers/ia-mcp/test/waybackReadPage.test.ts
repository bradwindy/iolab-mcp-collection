import { afterEach, describe, expect, it, vi } from "vitest";
import { waybackReadPageHandler } from "../src/tools/waybackReadPage.js";
import { fakeEnv } from "./support/fakeEnv.js";

const SAMPLE_HTML = `<!DOCTYPE html><html><head><title>t</title><script>evil()</script></head>
<body><nav>Skip me</nav><h1>Welcome</h1><p>Hello <a href="/about">about us</a>.</p></body></html>`;

/** Builds a fetch mock whose Response.url reflects the *actual* redirected URL — real `fetch`
 * with `redirect: "follow"` sets this to wherever the redirect chain landed, which is exactly
 * what fetchArchivedPage relies on to detect the actual-vs-requested timestamp mismatch. */
function pageResponse(finalUrl: string, html: string) {
  const response = new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

describe("ia_wayback_read_page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports the ACTUAL capture timestamp, not the requested one, when Wayback redirects to a different capture", async () => {
    // Confirmed live: requesting 20200101000000 landed on 20191231234501 — the id_ modifier
    // always 302s to the nearest actual capture at or before the requested timestamp.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(pageResponse("https://web.archive.org/web/20191231234501id_/https://example.org/", SAMPLE_HTML)),
    );

    const result = await waybackReadPageHandler({ url: "https://example.org/", timestamp: "20200101000000" }, fakeEnv());

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.requested_timestamp).toBe("20200101000000");
    expect(result.structuredContent?.actual_timestamp).toBe("20191231234501");
    expect(result.structuredContent?.actual_iso_date).toBe("2019-12-31T23:45:01Z");
  });

  it("strips script/nav tags in text mode but keeps the visible content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(pageResponse("https://web.archive.org/web/20200101000000id_/https://example.org/", SAMPLE_HTML)),
    );

    const result = await waybackReadPageHandler({ url: "https://example.org/", format: "text" }, fakeEnv());

    const content = result.structuredContent?.content as string;
    expect(content).toContain("Welcome");
    expect(content).toContain("Hello");
    expect(content).not.toContain("evil()");
    expect(content).not.toContain("Skip me");
  });

  it("markdown mode keeps heading structure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(pageResponse("https://web.archive.org/web/20200101000000id_/https://example.org/", SAMPLE_HTML)),
    );

    const result = await waybackReadPageHandler({ url: "https://example.org/", format: "markdown" }, fakeEnv());

    expect(result.structuredContent?.content as string).toContain("# Welcome");
  });

  it("links mode lists resolved absolute hrefs with their link text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(pageResponse("https://web.archive.org/web/20200101000000id_/https://example.org/", SAMPLE_HTML)),
    );

    const result = await waybackReadPageHandler({ url: "https://example.org/", format: "links" }, fakeEnv());

    const links = JSON.parse(result.structuredContent?.content as string);
    expect(links).toEqual([{ text: "about us", href: "https://example.org/about" }]);
  });

  it("pages long content via char_offset/max_chars", async () => {
    const longHtml = `<p>${"x".repeat(2000)}</p>`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(pageResponse("https://web.archive.org/web/20200101000000id_/https://example.org/", longHtml)),
    );

    const result = await waybackReadPageHandler({ url: "https://example.org/", max_chars: 500 }, fakeEnv());

    expect((result.structuredContent?.content as string).length).toBe(500);
    expect(result.structuredContent?.next_char_offset).toBe(500);
  });

  it("refuses a url whose dot-segments climb out of the capture path, and never fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const url of ["../../save/https://example.org/", "%2e%2e/%2e%2e/save/https://example.org/", "../../../cdx/search/cdx?url=x"]) {
      const result = await waybackReadPageHandler({ url, timestamp: "20200101" }, fakeEnv());
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("outside the Wayback capture path");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a proxied hop on the proxy even when a Wayback Location's path starts with //", async () => {
    const hosts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL) => {
        const url = new URL(input.toString());
        hosts.push(url.host);
        if (hosts.length === 1) {
          // An absolute Wayback Location whose path begins with "//": resolving that path against the
          // proxy URL would make "attacker.example" the host.
          return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://web.archive.org//attacker.example/x" } }));
        }
        return Promise.resolve(new Response("<html><body><p>x</p></body></html>", { status: 200, headers: { "content-type": "text/html" } }));
      }),
    );
    const env = { ...fakeEnv(), WAYBACK_PROXY_URL: "https://wayback.example.com", WAYBACK_PROXY_KEY: "sekrit" } as Env;
    await waybackReadPageHandler({ url: "https://example.org/", timestamp: "20200101" }, env);
    expect(hosts).toEqual(["wayback.example.com", "wayback.example.com"]);
  });

  it("follows the proxy's own absolute http://host:8080 Location back onto the proxy's https origin", async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input.toString());
        seen.push({ url: url.toString(), key: new Headers(init?.headers).get("X-Wayback-Key") });
        if (seen.length === 1) {
          // What nginx actually sends: proxy_redirect makes it relative, then absolute_redirect
          // re-adds the request's Host, the listener's port and the tunnel's plain-http scheme.
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: "http://wayback.example.com:8080/web/20241231120000id_/https://example.org/" } }),
          );
        }
        return Promise.resolve(new Response("<html><body><h1>Followed</h1></body></html>", { status: 200, headers: { "content-type": "text/html" } }));
      }),
    );
    const env = { ...fakeEnv(), WAYBACK_PROXY_URL: "https://wayback.example.com", WAYBACK_PROXY_KEY: "sekrit" } as Env;

    const result = await waybackReadPageHandler({ url: "https://example.org/", timestamp: "2024" }, env);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.actual_timestamp).toBe("20241231120000");
    expect(seen).toEqual([
      { url: "https://wayback.example.com/web/2024id_/https://example.org/", key: "sekrit" },
      { url: "https://wayback.example.com/web/20241231120000id_/https://example.org/", key: "sekrit" },
    ]);
  });
});
