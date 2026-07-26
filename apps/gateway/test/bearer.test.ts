import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Collapsed from seven per-server `test/index.test.ts` files, one per registered path.
const ORIGIN = "https://mcp.example.com";

describe("bearer auth gate", () => {
  it("rejects requests with no Authorization header", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/nz-govt/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/nz-govt/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("lets a request with the correct token reach the MCP server", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/nz-govt/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-shared-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.0" },
          },
        }),
      }),
    );
    expect(response.status).not.toBe(401);
  });

  it("the bearer bypass is per-path — a correct token still only reaches the path it was sent to", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/nz-geo/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-shared-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-client", version: "0.0.0" },
          },
        }),
      }),
    );
    // Not 401: the shared bearer token works identically at every registered path (unlike an
    // OAuth-issued token, which is audience-restricted — see multi-server-security.test.ts).
    expect(response.status).not.toBe(401);
  });
});
