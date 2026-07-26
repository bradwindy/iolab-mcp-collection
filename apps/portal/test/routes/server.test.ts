import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCredential, setCredential } from "@iolab/credentials";
import { app } from "../../src/app.js";
import { FakeD1, testEnv } from "../support/fakeD1.js";
import { resetAccessJwtTesting, setUpAccessJwtTesting } from "../support/accessJwt.js";

function formBody(fields: Record<string, string>): { body: string; headers: Record<string, string> } {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

let accessHeaders: Record<string, string>;

beforeAll(async () => {
  const signAccessJwt = await setUpAccessJwtTesting();
  accessHeaders = { "Cf-Access-Jwt-Assertion": await signAccessJwt() };
});
afterAll(() => resetAccessJwtTesting());

function withAccess(init: { body?: string; headers: Record<string, string>; method?: string }) {
  return { ...init, headers: { ...init.headers, ...accessHeaders } };
}

describe("GET /admin/servers/:slug", () => {
  it("404s for an unknown slug", async () => {
    const res = await app.request("/admin/servers/does-not-exist", { headers: accessHeaders }, testEnv());
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).toContain("does-not-exist");
  });

  it("renders a form per credential key for a known slug, initially 'not set'", async () => {
    const res = await app.request("/admin/servers/nz-geo-mcp", { headers: accessHeaders }, testEnv());
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("LINZ_API_KEY");
    expect(body).toContain("LINZ_BASEMAPS_API_KEY");
    // Match the full `class="badge badge-*"` attribute, not the bare substring — the shared
    // layout <style> block always defines both `.badge-set` and `.badge-unset` on every page.
    expect(body).toContain('class="badge badge-unset"');
    expect(body).not.toContain('class="badge badge-set"');
  });

  it("shows the 'no credentials required' message for nz-govt-mcp", async () => {
    const res = await app.request("/admin/servers/nz-govt-mcp", { headers: accessHeaders }, testEnv());
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("needs no upstream API keys");
  });

  it("escapes a malicious slug in the 404 page instead of rendering it as markup", async () => {
    const res = await app.request(
      "/admin/servers/" + encodeURIComponent("<script>alert(1)</script>"),
      { headers: accessHeaders },
      testEnv(),
    );
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain("<script>alert(1)</script>");
  });

  it("escapes a malicious 'updated' query parameter", async () => {
    const res = await app.request(
      "/admin/servers/nz-geo-mcp?updated=" + encodeURIComponent("<script>alert(1)</script>"),
      { headers: accessHeaders },
      testEnv(),
    );
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("403s without a valid Access JWT", async () => {
    const res = await app.request("/admin/servers/nz-geo-mcp", {}, testEnv());
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/servers/:slug", () => {
  it("sets a credential and it is reflected on the next GET", async () => {
    const db = new FakeD1();
    const env = testEnv({ credentialsDb: db });

    const postRes = await app.request(
      "/admin/servers/nz-geo-mcp",
      withAccess({ method: "POST", ...formBody({ key_name: "LINZ_API_KEY", value: "abc123" }) }),
      env,
    );

    expect(postRes.status).toBe(303);
    const location = postRes.headers.get("location");
    expect(location).toBe("/admin/servers/nz-geo-mcp?updated=LINZ_API_KEY");

    // the value was actually encrypted and stored, not lost
    expect(await getCredential(db, "nz-geo-mcp", "LINZ_API_KEY", env.ENCRYPTION_KEY)).toBe("abc123");

    const getRes = await app.request(location!, { headers: accessHeaders }, env);
    const body = await getRes.text();
    expect(body).toContain('class="badge badge-set"');
    expect(body).toContain("Saved");
    expect(body).not.toContain("abc123");
  });

  it("404s for an unknown slug", async () => {
    const res = await app.request(
      "/admin/servers/does-not-exist",
      withAccess({ method: "POST", ...formBody({ key_name: "X", value: "y" }) }),
      testEnv(),
    );

    expect(res.status).toBe(404);
  });

  it("rejects a key_name that isn't one of the server's declared credential keys", async () => {
    const db = new FakeD1();
    const env = testEnv({ credentialsDb: db });

    const res = await app.request(
      "/admin/servers/nz-geo-mcp",
      withAccess({ method: "POST", ...formBody({ key_name: "SOME_OTHER_KEY", value: "y" }) }),
      env,
    );

    expect(res.status).toBe(400);
    expect(db.rows.size).toBe(0);
  });

  it("clears a credential when the submitted value is blank", async () => {
    const db = new FakeD1();
    const env = testEnv({ credentialsDb: db });
    await setCredential(db, "nz-geo-mcp", "LINZ_API_KEY", "abc123", env.ENCRYPTION_KEY);

    const res = await app.request(
      "/admin/servers/nz-geo-mcp",
      withAccess({ method: "POST", ...formBody({ key_name: "LINZ_API_KEY", value: "" }) }),
      env,
    );

    expect(res.status).toBe(303);
    expect(await getCredential(db, "nz-geo-mcp", "LINZ_API_KEY", env.ENCRYPTION_KEY)).toBeNull();
  });

  it("trims whitespace-only values to a clear as well", async () => {
    const db = new FakeD1();
    const env = testEnv({ credentialsDb: db });
    await setCredential(db, "nz-geo-mcp", "LINZ_API_KEY", "abc123", env.ENCRYPTION_KEY);

    await app.request(
      "/admin/servers/nz-geo-mcp",
      withAccess({ method: "POST", ...formBody({ key_name: "LINZ_API_KEY", value: "   " }) }),
      env,
    );

    expect(await getCredential(db, "nz-geo-mcp", "LINZ_API_KEY", env.ENCRYPTION_KEY)).toBeNull();
  });

  it("keeps credentials for different servers independent", async () => {
    const db = new FakeD1();
    const env = testEnv({ credentialsDb: db });

    await app.request(
      "/admin/servers/nz-geo-mcp",
      withAccess({ method: "POST", ...formBody({ key_name: "LINZ_API_KEY", value: "geo-key" }) }),
      env,
    );
    await app.request(
      "/admin/servers/nz-environment-mcp",
      withAccess({ method: "POST", ...formBody({ key_name: "NIWA_API_KEY", value: "niwa-key" }) }),
      env,
    );

    expect(await getCredential(db, "nz-geo-mcp", "LINZ_API_KEY", env.ENCRYPTION_KEY)).toBe("geo-key");
    expect(await getCredential(db, "nz-environment-mcp", "NIWA_API_KEY", env.ENCRYPTION_KEY)).toBe("niwa-key");
  });

  it("403s without a valid Access JWT", async () => {
    const res = await app.request(
      "/admin/servers/nz-geo-mcp",
      { method: "POST", ...formBody({ key_name: "LINZ_API_KEY", value: "abc123" }) },
      testEnv(),
    );
    expect(res.status).toBe(403);
  });
});
