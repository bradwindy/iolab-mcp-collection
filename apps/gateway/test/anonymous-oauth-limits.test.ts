import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// /register and /token are public by design (claude.ai's connector flow needs both before any
// login). These pin the limits that stop an anonymous caller from turning them into KV spend or
// CPU burn. See guardAnonymousOAuthPost in @iolab/mcp-kit's oauth.ts.
const ORIGIN = "https://mcp.example.com";

async function countClientKeys(): Promise<number> {
  const listed = await env.OAUTH_KV.list({ prefix: "client:" });
  return listed.keys.length;
}

function register(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

const minimalClient = JSON.stringify({ redirect_uris: ["https://client.example.com/cb"], token_endpoint_auth_method: "none" });

describe("anonymous OAuth endpoint limits", () => {
  it("still accepts an ordinary registration", async () => {
    const response = await register(minimalClient);
    expect(response.status).toBe(201);
  });

  it("rejects an oversized registration and stores nothing", async () => {
    const before = await countClientKeys();
    const response = await register(
      JSON.stringify({
        redirect_uris: ["https://client.example.com/cb"],
        token_endpoint_auth_method: "none",
        client_name: "x".repeat(64 * 1024),
      }),
    );
    expect(response.status).toBe(413);
    expect(await countClientKeys()).toBe(before);
  });

  it("enforces the size cap even when the body has no Content-Length", async () => {
    const big = new TextEncoder().encode(
      JSON.stringify({ redirect_uris: ["https://client.example.com/cb"], client_name: "y".repeat(64 * 1024) }),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < big.length; i += 4096) controller.enqueue(big.slice(i, i + 4096));
        controller.close();
      },
    });
    const request = new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      // @ts-expect-error -- `duplex` is required by some runtimes for a streamed body, absent from older lib types.
      duplex: "half",
    });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await exports.default.fetch(request);
    expect(response.status).toBe(413);
  });

  it("rejects a /token form with thousands of fields before parsing it", async () => {
    const fields = Array.from({ length: 20_000 }, (_, i) => `k${i}=`).join("&");
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: fields,
      }),
    );
    expect(response.status).toBe(413);
  });

  it("still parses an ordinary /token request (and fails it on the grant, not the size)", async () => {
    const response = await exports.default.fetch(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=nope&client_id=nope",
      }),
    );
    expect(response.status).not.toBe(413);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("rate-limits registrations from one client IP", async () => {
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await register(minimalClient, { "CF-Connecting-IP": ip })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
    // A different client is unaffected.
    expect((await register(minimalClient, { "CF-Connecting-IP": "203.0.113.78" })).status).toBe(201);
  });
});
