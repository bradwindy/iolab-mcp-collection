import { describe, expect, it } from "vitest";
import { requireBearerToken } from "../src/auth.js";

describe("requireBearerToken", () => {
  it("returns 500 when the server has no expected token configured", async () => {
    const request = new Request("https://example.test/mcp");
    const result = requireBearerToken(request, undefined);
    expect(result?.status).toBe(500);
  });

  it("returns 401 when no Authorization header is present", () => {
    const request = new Request("https://example.test/mcp");
    const result = requireBearerToken(request, "secret-token");
    expect(result?.status).toBe(401);
  });

  it("returns 401 when the token does not match", () => {
    const request = new Request("https://example.test/mcp", {
      headers: { authorization: "Bearer wrong-token" },
    });
    const result = requireBearerToken(request, "secret-token");
    expect(result?.status).toBe(401);
  });

  it("returns null when the token matches", () => {
    const request = new Request("https://example.test/mcp", {
      headers: { authorization: "Bearer secret-token" },
    });
    const result = requireBearerToken(request, "secret-token");
    expect(result).toBeNull();
  });

  it("is case-insensitive on the Bearer scheme", () => {
    const request = new Request("https://example.test/mcp", {
      headers: { authorization: "bearer secret-token" },
    });
    const result = requireBearerToken(request, "secret-token");
    expect(result).toBeNull();
  });
});
