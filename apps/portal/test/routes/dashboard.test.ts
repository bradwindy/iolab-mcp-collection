import { describe, expect, it } from "vitest";
import { setCredential } from "@nz-mcp/credentials";
import { app } from "../../src/app.js";
import { SERVERS } from "../../src/manifest.js";
import { FakeD1, testEnv } from "../support/fakeD1.js";

describe("GET /", () => {
  it("renders every server in the manifest", async () => {
    const res = await app.request("/", {}, testEnv());
    const body = await res.text();

    expect(res.status).toBe(200);
    for (const server of SERVERS) {
      expect(body).toContain(server.slug);
      expect(body).toContain(server.subdomain);
    }
  });

  it("reflects credential status per server, without ever showing the plaintext value", async () => {
    const db = new FakeD1();
    const env = testEnv({ credentialsDb: db });
    await setCredential(db, "nz-geo-mcp", "LINZ_API_KEY", "super-secret-linz-key", env.ENCRYPTION_KEY);

    const res = await app.request("/", {}, env);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("LINZ_API_KEY");
    // Match the full `class="badge badge-set"` attribute, not the bare "badge-set" substring —
    // the shared layout <style> block always defines `.badge-set { ... }` on every page.
    expect(body).toContain('class="badge badge-set"');
    // the other nz-geo-mcp key was never set
    expect(body).toContain("LINZ_BASEMAPS_API_KEY");
    expect(body).not.toContain("super-secret-linz-key");
  });

  it("shows 'No credentials required' for nz-govt-mcp", async () => {
    const res = await app.request("/", {}, testEnv());
    const body = await res.text();

    expect(body).toContain("No credentials required");
  });

  it("sets basic security headers", async () => {
    const res = await app.request("/", {}, testEnv());

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
