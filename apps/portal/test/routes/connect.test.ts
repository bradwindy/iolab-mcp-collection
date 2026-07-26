import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { SERVERS } from "../../src/manifest.js";
import { testEnv } from "../support/fakeD1.js";
import { resetAccessJwtTesting, setUpAccessJwtTesting } from "../support/accessJwt.js";

describe("GET /admin/connect", () => {
  let headers: Record<string, string>;

  beforeAll(async () => {
    const signAccessJwt = await setUpAccessJwtTesting();
    headers = { "Cf-Access-Jwt-Assertion": await signAccessJwt() };
  });
  afterAll(() => resetAccessJwtTesting());

  it("interpolates the live MCP_SHARED_TOKEN into a command for every server", async () => {
    const res = await app.request("/admin/connect", { headers }, testEnv({ sharedToken: "live-secret-token" }));
    const body = await res.text();

    expect(res.status).toBe(200);
    for (const server of SERVERS) {
      expect(body).toContain(
        `claude mcp add --transport http ${server.slug} https://mcp.example.com/${server.pathPrefix}/mcp --header "Authorization: Bearer live-secret-token"`,
      );
    }
  });

  it("never hardcodes a token — different secrets produce different output", async () => {
    const resA = await app.request("/admin/connect", { headers }, testEnv({ sharedToken: "token-a" }));
    const resB = await app.request("/admin/connect", { headers }, testEnv({ sharedToken: "token-b" }));

    const bodyA = await resA.text();
    const bodyB = await resB.text();

    expect(bodyA).toContain("token-a");
    expect(bodyA).not.toContain("token-b");
    expect(bodyB).toContain("token-b");
    expect(bodyB).not.toContain("token-a");
  });

  it("sets Cache-Control: no-store since the token is rendered on this page", async () => {
    const res = await app.request("/admin/connect", { headers }, testEnv());

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("403s without a valid Access JWT", async () => {
    const res = await app.request("/admin/connect", {}, testEnv());
    expect(res.status).toBe(403);
  });
});
