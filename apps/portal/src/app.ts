import { Hono } from "hono";
import { getDashboard } from "./routes/dashboard.js";
import { getConnect } from "./routes/connect.js";
import { getServerPage, postServerCredential } from "./routes/server.js";
import { renderNotFound } from "./views/notFound.js";

export const app = new Hono<{ Bindings: Env }>();

// Basic security hygiene: Cloudflare Access already gates this whole hostname, but these
// headers cost nothing and reduce blast radius if that ever changes.
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

app.get("/", getDashboard);
app.get("/servers/:slug", getServerPage);
app.post("/servers/:slug", postServerCredential);
app.get("/connect", getConnect);

app.notFound(async (c) => c.html(await renderNotFound(c.req.path), 404));
