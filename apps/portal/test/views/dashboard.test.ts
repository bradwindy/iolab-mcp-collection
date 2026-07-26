import { describe, expect, it } from "vitest";
import { renderDashboard, type DashboardServerRow } from "../../src/views/dashboard.js";
import type { ServerManifestEntry } from "../../src/manifest.js";

function entry(overrides: Partial<ServerManifestEntry> = {}): ServerManifestEntry {
  return {
    slug: "nz-example-mcp",
    pathPrefix: "nz-example",
    credentialKeys: [],
    ...overrides,
  };
}

describe("renderDashboard", () => {
  it("lists every server with its slug and path-prefixed gateway URL", async () => {
    const rows: DashboardServerRow[] = [
      { entry: entry({ slug: "nz-geo-mcp", pathPrefix: "nz-geo" }), statuses: [] },
      { entry: entry({ slug: "nz-govt-mcp", pathPrefix: "nz-govt" }), statuses: [] },
    ];

    const body = String(await renderDashboard(rows, "example.com"));

    expect(body).toContain("nz-geo-mcp");
    expect(body).toContain("https://mcp.example.com/nz-geo/mcp");
    expect(body).toContain("nz-govt-mcp");
    expect(body).toContain("https://mcp.example.com/nz-govt/mcp");
  });

  it("shows 'No credentials required' for a server with no credential keys", async () => {
    const rows: DashboardServerRow[] = [{ entry: entry({ credentialKeys: [] }), statuses: [] }];

    const body = String(await renderDashboard(rows, "example.com"));

    expect(body).toContain("No credentials required");
  });

  it("reflects set vs. not-set status per credential key", async () => {
    const rows: DashboardServerRow[] = [
      {
        entry: entry({
          credentialKeys: [
            { envName: "KEY_A", label: "Key A", signupUrl: "https://example.test/a" },
            { envName: "KEY_B", label: "Key B", signupUrl: "https://example.test/b" },
          ],
        }),
        statuses: [
          { keyName: "KEY_A", isSet: true, updatedAt: "2026-07-01T00:00:00.000Z" },
          { keyName: "KEY_B", isSet: false, updatedAt: null },
        ],
      },
    ];

    const body = String(await renderDashboard(rows, "example.com"));

    // Match the full `class="badge badge-set"` attribute, not the bare "badge-set" substring —
    // the layout's shared <style> block always defines `.badge-set { ... }`, so a bare substring
    // check would be true on every page regardless of which badge actually rendered.
    expect(body).toContain("KEY_A");
    expect(body).toContain('class="badge badge-set"');
    expect(body).toContain("2026-07-01T00:00:00.000Z");
    expect(body).toContain("KEY_B");
    expect(body).toContain('class="badge badge-unset"');
  });

  it("escapes a malicious server slug instead of rendering it as markup", async () => {
    const rows: DashboardServerRow[] = [
      { entry: entry({ slug: "<script>alert(1)</script>" }), statuses: [] },
    ];

    const body = String(await renderDashboard(rows, "example.com"));

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("escapes a malicious credential updatedAt value", async () => {
    const rows: DashboardServerRow[] = [
      {
        entry: entry({
          credentialKeys: [{ envName: "KEY_A", label: "Key A", signupUrl: "https://example.test/a" }],
        }),
        statuses: [{ keyName: "KEY_A", isSet: true, updatedAt: "<img src=x onerror=alert(1)>" }],
      },
    ];

    const body = String(await renderDashboard(rows, "example.com"));

    expect(body).not.toContain("<img src=x onerror=alert(1)>");
    expect(body).toContain("&lt;img");
  });
});
