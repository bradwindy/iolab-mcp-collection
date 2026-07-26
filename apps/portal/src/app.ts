import { Hono } from "hono";
// Deliberately the dedicated subpath, not the main "@iolab/mcp-kit" barrel: that barrel also
// re-exports oauth.ts, which imports `@cloudflare/workers-oauth-provider` — whose dist bundle does
// a bare `import ... from "cloudflare:workers"` at module scope. That breaks this package's own
// tests, which exercise the Hono app directly under plain Node (no Workers runtime). See
// packages/mcp-kit/src/access.ts for the full explanation.
import { verifyAccessJwt } from "@iolab/mcp-kit/access";
import { getLanding } from "./routes/landing.js";
import { getDashboard } from "./routes/dashboard.js";
import { getConnect } from "./routes/connect.js";
import { getServerPage, postServerCredential } from "./routes/server.js";
import { renderNotFound } from "./views/notFound.js";

export const app = new Hono<{ Bindings: Env }>();

// Basic security hygiene: these headers cost nothing and reduce blast radius regardless of
// which path serves the response.
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

// The gateway's single shared hostname can no longer be entirely covered by one Cloudflare
// Access application the way this portal's own hostname used to be — /token, /register, and
// /.well-known/* on that same hostname must stay public for machine-to-machine OAuth calls, so
// Access is only configured to gate /authorize (see docs/SETUP.md). Everything under /admin — the
// credential-management UI, including the page that renders MCP_SHARED_TOKEN in plaintext — is
// therefore authorized here in code instead, against the same Access session (the `CF_Authorization`
// cookie is domain-wide once the operator has completed the Access login at /authorize once).
// A scoping mistake in the gateway's routing is then a 403 from this check, not a credential leak.
app.use("/admin/*", async (c, next) => {
  const identity = await verifyAccessJwt(c.req.raw, c.env);
  if (!identity) {
    return c.text("Forbidden: Cloudflare Access did not authenticate this request.", 403);
  }
  await next();
});

app.get("/", getLanding);
app.get("/admin", getDashboard);
app.get("/admin/servers/:slug", getServerPage);
app.post("/admin/servers/:slug", postServerCredential);
app.get("/admin/connect", getConnect);

app.notFound(async (c) => c.html(await renderNotFound(c.req.path), 404));
