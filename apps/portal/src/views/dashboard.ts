import { html } from "hono/html";
import type { CredentialStatus } from "@iolab/credentials";
import type { ServerManifestEntry } from "../manifest.js";
import { layout } from "./layout.js";

export type DashboardServerRow = {
  entry: ServerManifestEntry;
  statuses: CredentialStatus[];
};

function statusBadge(status: CredentialStatus) {
  return status.isSet
    ? html`<span class="badge badge-set">set</span> <span class="meta">updated ${status.updatedAt ?? "unknown"}</span>`
    : html`<span class="badge badge-unset">not set</span>`;
}

function serverCard(row: DashboardServerRow, baseDomain: string) {
  const { entry, statuses } = row;
  const statusByKey = new Map(statuses.map((status) => [status.keyName, status]));
  const url = `https://mcp.${baseDomain}/${entry.pathPrefix}/mcp`;

  return html`
    <article class="card">
      <h2><a href="/admin/servers/${entry.slug}">${entry.slug}</a></h2>
      <p class="url"><a href="${url}">${url}</a></p>
      ${
        entry.credentialKeys.length === 0
          ? html`<p class="badge badge-none">No credentials required</p>`
          : html`<ul class="cred-list">
              ${entry.credentialKeys.map((key) => {
                const status = statusByKey.get(key.envName);
                return html`<li><code>${key.envName}</code> ${status ? statusBadge(status) : html`<span class="badge badge-unset">not set</span>`}</li>`;
              })}
            </ul>`
      }
      <p><a class="button" href="/admin/servers/${entry.slug}">Manage credentials</a></p>
    </article>
  `;
}

export function renderDashboard(rows: readonly DashboardServerRow[], baseDomain: string) {
  return layout(
    "Dashboard",
    html`
      <h1>MCP Server Dashboard</h1>
      <p>
        Every server in the nz-mcp-collection, its live MCP endpoint, and whether its required
        upstream API keys are set. See <a href="/admin/connect">Connect</a> for how to add these to
        Claude Code or claude.ai.
      </p>
      <div class="grid">${rows.map((row) => serverCard(row, baseDomain))}</div>
    `,
  );
}
