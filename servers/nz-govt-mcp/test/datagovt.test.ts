import { describe, expect, it } from "vitest";
import { ckanCacheKey, handleDatagovtError, UpstreamActionError, UpstreamFetchError } from "../src/clients/datagovt.js";
import { UpstreamHttpError } from "@iolab/mcp-kit";

describe("ckanCacheKey", () => {
  it("doesn't alias two different (action, params) pairs whose naive `key=value` join would collide", async () => {
    // `q: "a&limit=1", limit: "5"` and `q: "a", limit: "1&limit=5"` both naively serialize to
    // "limit=1&limit=5&q=a" — URLSearchParams-based serialization must keep them distinct.
    const keyA = await ckanCacheKey("package_search", { q: "a&limit=1", limit: "5" });
    const keyB = await ckanCacheKey("package_search", { q: "a", limit: "1&limit=5" });
    expect(keyA).not.toBe(keyB);
  });

  it("is still deterministic for the same (action, params) regardless of key insertion order", async () => {
    const keyA = await ckanCacheKey("datastore_search", { resource_id: "abc", q: "x" });
    const keyB = await ckanCacheKey("datastore_search", { q: "x", resource_id: "abc" });
    expect(keyA).toBe(keyB);
  });
});

describe("handleDatagovtError", () => {
  it("maps UpstreamActionError to the caller-supplied hint", () => {
    const result = handleDatagovtError(new UpstreamActionError("data.govt.nz", "package_search", "boom"), "my hint");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("my hint");
  });

  it("maps UpstreamFetchError to neutral wording, not a network-specific claim", () => {
    const result = handleDatagovtError(new UpstreamFetchError("data.govt.nz", "package_search", new Error("bad json")), "unused");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text.toLowerCase()).not.toContain("transient network issue");
  });

  it("rethrows anything that isn't one of this client's three error types", () => {
    expect(() => handleDatagovtError(new Error("unrelated"), "hint")).toThrow("unrelated");
  });

  it("maps UpstreamHttpError via the shared upstreamError formatter", () => {
    const response = new Response("", { status: 503, statusText: "Service Unavailable" });
    const result = handleDatagovtError(new UpstreamHttpError("data.govt.nz", response), "unused");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("503");
  });
});
