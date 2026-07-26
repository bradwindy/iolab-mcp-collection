import type { Context } from "hono";
import { renderLanding } from "../views/landing.js";

export async function getLanding(c: Context<{ Bindings: Env }>) {
  return c.html(await renderLanding());
}
