import { describe, expect, it } from "vitest";
import { renderConnect } from "../../src/views/connect.js";
import { SERVERS } from "../../src/manifest.js";

describe("renderConnect", () => {
  it("renders a claude mcp add command for every server with the live token interpolated", async () => {
    const body = String(await renderConnect(SERVERS, "my-shared-token", "example.com", "you@example.com"));

    for (const server of SERVERS) {
      expect(body).toContain(
        `claude mcp add --transport http ${server.slug} https://${server.subdomain}.example.com/mcp --header "Authorization: Bearer my-shared-token"`,
      );
    }
  });

  it("escapes a token value that happens to contain HTML-significant characters", async () => {
    const body = String(await renderConnect(SERVERS, "<script>alert(1)</script>", "example.com", "you@example.com"));

    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toContain("&lt;script&gt;");
  });

  it("renders the bare /mcp URL for every server, for claude.ai's custom-connector flow", async () => {
    const body = String(await renderConnect(SERVERS, "my-shared-token", "example.com", "you@example.com"));

    for (const server of SERVERS) {
      const url = `https://${server.subdomain}.example.com/mcp`;
      expect(body).toContain(`<pre><code>${url}</code></pre>`);
    }
    expect(body).toContain("Add custom connector");
  });
});
