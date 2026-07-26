import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { testEnv } from "./support/fakeD1.js";

describe("GET / (public landing page)", () => {
  it("renders without any Access JWT", async () => {
    const res = await app.request("/", {}, testEnv());
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("iolab MCP fleet");
  });

  it("never mentions a server, its credential status, or the shared token", async () => {
    const res = await app.request("/", {}, testEnv({ sharedToken: "super-secret-token" }));
    const body = await res.text();

    expect(body).not.toContain("super-secret-token");
    expect(body).not.toContain("nz-geo-mcp");
  });
});

describe("/admin/* access guard", () => {
  it("403s a request with no Access JWT at all, before any route-specific logic runs", async () => {
    const res = await app.request("/admin/does-not-exist-either", {}, testEnv());
    expect(res.status).toBe(403);
  });

  it("403s a request with a garbage Access JWT", async () => {
    const res = await app.request(
      "/admin",
      { headers: { "Cf-Access-Jwt-Assertion": "not-a-real-jwt" } },
      testEnv(),
    );
    expect(res.status).toBe(403);
  });
});

describe("unmatched routes", () => {
  it("returns a 404 page mentioning the requested path", async () => {
    const res = await app.request("/nope", {}, testEnv());
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).toContain("/nope");
  });

  it("escapes a malicious unmatched path", async () => {
    const res = await app.request("/%3Cscript%3E", {}, testEnv());
    const body = await res.text();

    expect(body).not.toContain("<script>");
  });
});

describe("security headers", () => {
  it("are present even on error responses", async () => {
    const res = await app.request("/nope", {}, testEnv());

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
