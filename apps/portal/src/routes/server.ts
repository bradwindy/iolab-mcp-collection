import type { Context } from "hono";
import { deleteCredential, listCredentialStatus, setCredential } from "@nz-mcp/credentials";
import { findServer } from "../manifest.js";
import { renderServerNotFound, renderServerPage } from "../views/serverPage.js";

type ServerRouteContext = Context<{ Bindings: Env }, "/servers/:slug">;

export async function getServerPage(c: ServerRouteContext) {
  const slug = c.req.param("slug");
  const entry = findServer(slug);
  if (!entry) {
    return c.html(await renderServerNotFound(slug), 404);
  }

  const statuses = await listCredentialStatus(
    c.env.CREDENTIALS_DB,
    entry.slug,
    entry.credentialKeys.map((key) => key.envName),
  );
  const updatedKey = c.req.query("updated") ?? null;

  return c.html(await renderServerPage(entry, statuses, updatedKey, c.env.BASE_DOMAIN));
}

export async function postServerCredential(c: ServerRouteContext) {
  const slug = c.req.param("slug");
  const entry = findServer(slug);
  if (!entry) {
    return c.html(await renderServerNotFound(slug), 404);
  }

  const body = await c.req.parseBody();
  const keyName = typeof body["key_name"] === "string" ? body["key_name"] : "";
  const value = typeof body["value"] === "string" ? body["value"] : "";

  const keyDescriptor = entry.credentialKeys.find((key) => key.envName === keyName);
  if (!keyDescriptor) {
    return c.text(
      `Unknown credential key '${keyName}' for server '${entry.slug}'. Reload the page and use one of its listed keys.`,
      400,
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    await deleteCredential(c.env.CREDENTIALS_DB, entry.slug, keyDescriptor.envName);
  } else {
    await setCredential(c.env.CREDENTIALS_DB, entry.slug, keyDescriptor.envName, trimmed, c.env.ENCRYPTION_KEY);
  }

  return c.redirect(`/servers/${entry.slug}?updated=${encodeURIComponent(keyDescriptor.envName)}`, 303);
}
