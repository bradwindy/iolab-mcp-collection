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
});
