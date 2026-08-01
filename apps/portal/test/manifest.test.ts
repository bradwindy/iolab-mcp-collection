import { describe, expect, it } from "vitest";
import { findServer, SERVERS } from "../src/manifest.js";

describe("manifest", () => {
  it("has 10 servers with unique slugs and unique path prefixes", () => {
    const slugs = SERVERS.map((server) => server.slug);
    const pathPrefixes = SERVERS.map((server) => server.pathPrefix);

    expect(SERVERS).toHaveLength(10);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(pathPrefixes).size).toBe(pathPrefixes.length);
  });

  it("registers wikimedia-mcp with the path prefix and credential name its server reads", () => {
    // The count and uniqueness checks above would be satisfied by any ninth entry. A slug or
    // key-name mismatch here writes a credential row the server can never read back, which
    // docs/ADDING_A_SERVER.md §7 records as having happened once already.
    const wikimedia = findServer("wikimedia-mcp");
    expect(wikimedia?.pathPrefix).toBe("wikimedia");
    expect(wikimedia?.credentialKeys.map((key) => key.envName)).toEqual(["WIKIMEDIA_OAUTH_TOKEN"]);
  });

  it("registers reddit-mcp with the path prefix and credential names its server reads", () => {
    // reddit-mcp is the first server where every tool is credential-gated (Reddit returns 403 to
    // all anonymous API requests), so a slug or key-name mismatch here is not a partial outage —
    // it makes the whole server permanently unusable with no way to tell from the portal.
    const reddit = findServer("reddit-mcp");
    expect(reddit?.pathPrefix).toBe("reddit");
    expect(reddit?.credentialKeys.map((key) => key.envName)).toEqual([
      "REDDIT_CLIENT_ID",
      "REDDIT_CLIENT_SECRET",
      "REDDIT_USERNAME",
    ]);
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
