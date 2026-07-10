import { html } from "hono/html";
import type { CredentialStatus } from "@nz-mcp/credentials";
import type { CredentialKeyDescriptor, ServerManifestEntry } from "../manifest.js";
import { layout } from "./layout.js";

function credentialForm(slug: string, key: CredentialKeyDescriptor, status: CredentialStatus | undefined) {
  const inputId = `${slug}-${key.envName}-value`;
  return html`
    <section class="cred-form">
      <h2><code>${key.envName}</code></h2>
      <p>${key.label}</p>
      <p>
        ${status?.isSet
          ? html`<span class="badge badge-set">set</span> <span class="meta">last updated ${status.updatedAt ?? "unknown"}</span>`
          : html`<span class="badge badge-unset">not set</span>`}
      </p>
      <p><a href="${key.signupUrl}" rel="noreferrer noopener" target="_blank">Sign up for a key &rarr;</a></p>
      <form method="post" action="/servers/${slug}">
        <input type="hidden" name="key_name" value="${key.envName}" />
        <label for="${inputId}">Value</label>
        <input
          id="${inputId}"
          type="password"
          name="value"
          autocomplete="off"
          placeholder="Paste new value, or leave blank and save to clear"
        />
        <button type="submit">Save</button>
      </form>
    </section>
  `;
}

export function renderServerPage(
  entry: ServerManifestEntry,
  statuses: readonly CredentialStatus[],
  updatedKey: string | null,
  baseDomain: string,
) {
  const statusByKey = new Map(statuses.map((status) => [status.keyName, status]));
  const url = `https://${entry.subdomain}.${baseDomain}/mcp`;

  return layout(
    entry.slug,
    html`
      <p><a href="/">&larr; Back to dashboard</a></p>
      <h1>${entry.slug}</h1>
      <p class="url"><a href="${url}">${url}</a></p>
      ${updatedKey ? html`<p class="flash">Saved <code>${updatedKey}</code>.</p>` : ""}
      ${
        entry.credentialKeys.length === 0
          ? html`<p class="badge badge-none">
              This server needs no upstream API keys to run — every API it wraps is public.
            </p>`
          : entry.credentialKeys.map((key) => credentialForm(entry.slug, key, statusByKey.get(key.envName)))
      }
    `,
  );
}

export function renderServerNotFound(slug: string) {
  return layout(
    "Not found",
    html`
      <p><a href="/">&larr; Back to dashboard</a></p>
      <h1>No such server</h1>
      <p>There's no server in the collection with slug <code>${slug}</code>.</p>
    `,
  );
}
