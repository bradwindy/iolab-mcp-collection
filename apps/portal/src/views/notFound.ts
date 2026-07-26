import { html } from "hono/html";
import { layout } from "./layout.js";

export function renderNotFound(path: string) {
  return layout(
    "Not found",
    html`
      <p><a href="/">&larr; Back to home</a></p>
      <h1>404</h1>
      <p>No route matches <code>${path}</code>.</p>
    `,
  );
}
