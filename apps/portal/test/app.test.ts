import { describe, expect, it } from "vitest";
import { app } from "../src/app.js";
import { testEnv } from "./support/fakeD1.js";

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
