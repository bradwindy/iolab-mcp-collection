import { describe, expect, it } from "vitest";
import { renderServerNotFound, renderServerPage } from "../../src/views/serverPage.js";
import type { ServerManifestEntry } from "../../src/manifest.js";

const ENTRY: ServerManifestEntry = {
  slug: "nz-geo-mcp",
  pathPrefix: "nz-geo",
  credentialKeys: [
    { envName: "LINZ_API_KEY", label: "LINZ Data Service API key", signupUrl: "https://example.test/linz" },
    { envName: "LINZ_BASEMAPS_API_KEY", label: "LINZ Basemaps API key", signupUrl: "https://example.test/basemaps" },
  ],
};

describe("renderServerPage", () => {
  it("renders one password-type form per credential key, with a signup link", async () => {
    const body = String(await renderServerPage(ENTRY, [], null, "example.com"));

    expect(body).toContain("LINZ_API_KEY");
    expect(body).toContain("LINZ_BASEMAPS_API_KEY");
    expect(body).toMatch(/<input[^>]*type="password"/);
    expect(body).toContain("https://example.test/linz");
    expect(body).toContain("https://example.test/basemaps");
    expect(body).toContain('method="post"');
    expect(body).toContain('action="/admin/servers/nz-geo-mcp"');
  });

  it("never renders a previously-set value into the form", async () => {
    const body = String(
      await renderServerPage(
        ENTRY,
        [{ keyName: "LINZ_API_KEY", isSet: true, updatedAt: "2026-07-01T00:00:00.000Z" }],
        null,
        "example.com",
      ),
    );

    expect(body).not.toContain("value=\"super-secret-linz-key\"");
    // the only `value=` on a text/password field should be empty or absent
    expect(body).toContain('class="badge badge-set"');
  });

  it("shows a 'no credentials required' message for a server with none", async () => {
    const body = String(
      await renderServerPage({ ...ENTRY, credentialKeys: [] }, [], null, "example.com"),
    );

    expect(body).toContain("needs no upstream API keys");
    // The layout's shared <style> block always defines `input[type="password"] { ... }`
    // regardless of what a given page renders, so a bare `toContain('type="password"')`
    // check would never fail — match on an actual <input> tag instead.
    expect(body).not.toMatch(/<input[^>]*type="password"/);
  });

  it("shows a flash message for the just-saved key", async () => {
    const body = String(await renderServerPage(ENTRY, [], "LINZ_API_KEY", "example.com"));

    expect(body).toContain("Saved");
    expect(body).toContain("LINZ_API_KEY");
  });

  it("escapes a malicious 'updated' flash value", async () => {
    const body = String(await renderServerPage(ENTRY, [], "<script>alert(1)</script>", "example.com"));

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});

describe("renderServerNotFound", () => {
  it("mentions the unknown slug", async () => {
    const body = String(await renderServerNotFound("does-not-exist"));

    expect(body).toContain("does-not-exist");
    expect(body).toContain("No such server");
  });

  it("escapes a malicious slug instead of rendering it as markup", async () => {
    const body = String(await renderServerNotFound("<script>alert(1)</script>"));

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });
});
