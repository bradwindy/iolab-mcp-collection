import type { Context } from "hono";
import { listCredentialStatus } from "@iolab/credentials";
import { SERVERS } from "../manifest.js";
import { renderDashboard, type DashboardServerRow } from "../views/dashboard.js";

export async function getDashboard(c: Context<{ Bindings: Env }>) {
  const rows: DashboardServerRow[] = await Promise.all(
    SERVERS.map(async (entry) => ({
      entry,
      statuses: await listCredentialStatus(
        c.env.CREDENTIALS_DB,
        entry.slug,
        entry.credentialKeys.map((key) => key.envName),
      ),
    })),
  );

  return c.html(await renderDashboard(rows, c.env.BASE_DOMAIN));
}
