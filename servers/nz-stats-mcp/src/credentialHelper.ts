import { getCredential } from "@nz-mcp/credentials";
import { missingCredentialError, type ToolTextResult } from "@nz-mcp/mcp-kit";
import { CREDENTIAL_SERVER_SLUG, SUBSCRIPTION_KEY_NAME } from "./constants.js";

export type CredentialResolution =
  | { ok: true; subscriptionKey: string }
  | { ok: false; error: ToolTextResult };

/**
 * Every tool in this server needs the Stats NZ API portal subscription key — there is no
 * public/no-key path for the Aotearoa Data Explorer SDMX API. Resolve it once per call.
 */
export async function resolveSubscriptionKey(env: Env): Promise<CredentialResolution> {
  const subscriptionKey = await getCredential(
    env.CREDENTIALS_DB,
    CREDENTIAL_SERVER_SLUG,
    SUBSCRIPTION_KEY_NAME,
    env.ENCRYPTION_KEY,
  );
  if (!subscriptionKey) {
    return { ok: false, error: missingCredentialError(CREDENTIAL_SERVER_SLUG, SUBSCRIPTION_KEY_NAME, env.PORTAL_URL) };
  }
  return { ok: true, subscriptionKey };
}
