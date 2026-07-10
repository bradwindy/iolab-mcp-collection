import type { Context } from "hono";
import { SERVERS } from "../manifest.js";
import { renderConnect } from "../views/connect.js";

export async function getConnect(c: Context<{ Bindings: Env }>) {
  c.header("Cache-Control", "no-store");
  return c.html(await renderConnect(SERVERS, c.env.MCP_SHARED_TOKEN));
}
