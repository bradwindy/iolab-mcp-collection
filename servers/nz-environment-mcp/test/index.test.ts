import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("bearer auth gate", () => {
  it("rejects requests with no Authorization header", async () => {
    const response = await exports.default.fetch(
      new Request("https://nz-environment.mcp.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    const response = await exports.default.fetch(
      new Request("https://nz-environment.mcp.example.com/mcp", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("lets a request with the correct token reach the MCP server", async () => {
    const response = await exports.default.fetch(
      new Request("https://nz-environment.mcp.example.com/mcp", {
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
});
