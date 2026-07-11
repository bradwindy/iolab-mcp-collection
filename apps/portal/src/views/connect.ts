import { html } from "hono/html";
import type { ServerManifestEntry } from "../manifest.js";
import { layout } from "./layout.js";

function mcpUrl(entry: ServerManifestEntry, baseDomain: string) {
  return `https://${entry.subdomain}.${baseDomain}/mcp`;
}

function connectCommand(entry: ServerManifestEntry, token: string, baseDomain: string) {
  return html`claude mcp add --transport http ${entry.slug} ${mcpUrl(entry, baseDomain)} --header "Authorization: Bearer ${token}"`;
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
        Run the matching command below to add a server to Claude Code (user scope).
      </p>
      <div class="commands">
        ${servers.map((entry) => html`<pre><code>${connectCommand(entry, token, baseDomain)}</code></pre>`)}
      </div>
      <h2>claude.ai / Claude mobile</h2>
      <p>
        claude.ai's custom connectors use an interactive OAuth login instead of a pasted header —
        Settings &rarr; Connectors &rarr; <strong>Add custom connector</strong> &rarr; paste the
        server's <code>/mcp</code> URL below, then sign in via Cloudflare Access when prompted.
        This only works for servers you've enabled OAuth on (see
        <code>docs/SETUP.md</code> &sect;8) — attempting it on a server without OAuth configured
        will fail the login step.
      </p>
      <div class="commands">
        ${servers.map((entry) => html`<pre><code>${mcpUrl(entry, baseDomain)}</code></pre>`)}
      </div>
      <p class="meta">
        This page is only reachable through Cloudflare Access (${accessEmail}). The token
        above is read live from this Worker's secret at request time — it is never stored in
        this repository and this response is never cached (<code>Cache-Control: no-store</code>).
      </p>
    `,
  );
}
