import { html } from "hono/html";
import type { ServerManifestEntry } from "../manifest.js";
import { layout } from "./layout.js";

function connectCommand(entry: ServerManifestEntry, token: string, baseDomain: string) {
  return html`claude mcp add --transport http ${entry.slug} https://${entry.subdomain}.${baseDomain}/mcp --header "Authorization: Bearer ${token}"`;
}

export function renderConnect(
  servers: readonly ServerManifestEntry[],
  token: string,
  baseDomain: string,
  accessEmail: string,
) {
  return layout(
    "Connect",
    html`
      <p><a href="/">&larr; Back to dashboard</a></p>
      <h1>Connect to Claude Code / claude.ai</h1>
      <p>
        Every server in the collection is a remote MCP server that shares one bearer token.
        Run the matching command below to add a server to Claude Code (user scope), or use the
        same URL + <code>Authorization: Bearer</code> header pattern when adding a custom
        connector in claude.ai.
      </p>
      <div class="commands">
        ${servers.map((entry) => html`<pre><code>${connectCommand(entry, token, baseDomain)}</code></pre>`)}
      </div>
      <p class="meta">
        This page is only reachable through Cloudflare Access (${accessEmail}). The token
        above is read live from this Worker's secret at request time — it is never stored in
        this repository and this response is never cached (<code>Cache-Control: no-store</code>).
      </p>
    `,
  );
}
