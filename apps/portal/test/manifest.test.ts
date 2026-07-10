import { describe, expect, it } from "vitest";
import { findServer, SERVERS } from "../src/manifest.js";

describe("manifest", () => {
  it("has 7 servers with unique slugs and unique subdomains", () => {
    const slugs = SERVERS.map((server) => server.slug);
    const subdomains = SERVERS.map((server) => server.subdomain);

    expect(SERVERS).toHaveLength(7);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(subdomains).size).toBe(subdomains.length);
  });

  it("gives every credential key a label and an https signup URL", () => {
    for (const server of SERVERS) {
      for (const key of server.credentialKeys) {
        expect(key.envName).toMatch(/^[A-Z0-9_]+$/);
        expect(key.label.length).toBeGreaterThan(0);
        expect(key.signupUrl.startsWith("https://")).toBe(true);
      }
    }
  });

  it("includes nz-govt-mcp with no required credentials", () => {
    const govt = findServer("nz-govt-mcp");
    expect(govt).toBeDefined();
    expect(govt?.credentialKeys).toEqual([]);
  });

  it("findServer returns undefined for an unknown slug", () => {
    expect(findServer("does-not-exist")).toBeUndefined();
  });
});
