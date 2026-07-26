import { html } from "hono/html";
import { layout } from "./layout.js";

/**
 * Public, unauthenticated landing page — deliberately minimal. Unlike the dashboard this used to
 * be, nothing here is a secret or an operational detail (server list, credential status): this
 * page is reachable by anyone who finds the hostname, since Cloudflare Access on the shared
 * gateway hostname only gates /authorize (see docs/SETUP.md).
 */
export function renderLanding() {
  return layout(
    "iolab MCP fleet",
    html`
      <h1>iolab MCP fleet</h1>
      <p>A private collection of remote MCP servers. The management dashboard is at
        <a href="/admin">/admin</a>, behind Cloudflare Access.</p>
    `,
  );
}
