import { html, raw } from "hono/html";

// Static, trusted, hand-written CSS — the only place this file uses raw(), since html``
// would otherwise HTML-escape the quotes/angle-brackets that plain CSS is full of. Nothing
// here is derived from user input, the database, or a request.
const CSS = `
  :root {
    color-scheme: light dark;
    --bg: #f7f7f8;
    --card: #ffffff;
    --text: #1a1a1a;
    --muted: #5b5f66;
    --border: #dcdfe4;
    --accent: #1d4ed8;
    --set: #0f7a3d;
    --set-bg: #e6f6ec;
    --unset: #9a6300;
    --unset-bg: #fdf3dc;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16171a;
      --card: #212226;
      --text: #ecedee;
      --muted: #a3a7ae;
      --border: #34363b;
      --accent: #6ea8fe;
      --set: #4fd67f;
      --set-bg: #123321;
      --unset: #f0c36d;
      --unset-bg: #3a2c0c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  a { color: var(--accent); }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: var(--border);
    padding: 0.1em 0.35em;
    border-radius: 4px;
    font-size: 0.9em;
  }
  header.topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border);
  }
  header.topbar .brand { font-weight: 600; text-decoration: none; color: var(--text); }
  header.topbar nav a { margin-left: 1.25rem; text-decoration: none; }
  main { max-width: 960px; margin: 0 auto; padding: 1.5rem; }
  footer { max-width: 960px; margin: 2rem auto; padding: 0 1.5rem 2rem; color: var(--muted); font-size: 0.85em; }
  h1 { margin-top: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .card, .cred-form {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.25rem;
  }
  .card h2 { margin: 0 0 0.5rem; font-size: 1.1em; }
  .card h2 a { text-decoration: none; }
  .url { font-size: 0.9em; word-break: break-all; }
  .cred-list { list-style: none; margin: 0.5rem 0; padding: 0; }
  .cred-list li { margin: 0.4rem 0; }
  .badge {
    display: inline-block;
    padding: 0.15em 0.6em;
    border-radius: 999px;
    font-size: 0.8em;
    font-weight: 600;
  }
  .badge-set { color: var(--set); background: var(--set-bg); }
  .badge-unset { color: var(--unset); background: var(--unset-bg); }
  .badge-none { color: var(--muted); background: transparent; padding-left: 0; }
  .meta { color: var(--muted); font-size: 0.85em; }
  .button {
    display: inline-block;
    margin-top: 0.5rem;
    padding: 0.4em 0.9em;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    text-decoration: none;
    font-size: 0.9em;
  }
  .cred-form { margin: 1rem 0; }
  .cred-form form { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; flex-wrap: wrap; }
  .cred-form input[type="password"] {
    flex: 1 1 260px;
    padding: 0.45em 0.6em;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
  }
  .cred-form button {
    padding: 0.45em 1em;
    border: none;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
  }
  .flash {
    background: var(--set-bg);
    color: var(--set);
    border-radius: 8px;
    padding: 0.6em 1em;
    font-size: 0.9em;
  }
  .commands pre {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.9em 1em;
    overflow-x: auto;
    font-size: 0.85em;
  }
`;

/** Shared page shell: doctype, nav, and footer. `body` is already-escaped HTML from a view function. */
export function layout(title: string, body: unknown) {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · NZ MCP Portal</title>
    <style>${raw(CSS)}</style>
  </head>
  <body>
    <header class="topbar">
      <a class="brand" href="/">NZ MCP Portal</a>
      <nav>
        <a href="/">Dashboard</a>
        <a href="/connect">Connect</a>
      </nav>
    </header>
    <main>${body}</main>
    <footer>
      <p>
        Internal credential manager for the nz-mcp-collection. Values are encrypted at rest
        (AES-256-GCM) in a shared D1 database and are only ever decrypted by the MCP server
        that needs them — the portal itself never displays a previously-set value.
      </p>
    </footer>
  </body>
</html>`;
}
