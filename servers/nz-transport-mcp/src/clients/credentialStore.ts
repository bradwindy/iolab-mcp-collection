import { getCredential } from "@nz-mcp/credentials";
import { AT_SUBSCRIPTION_KEY_NAME, SERVER_SLUG } from "../constants.js";

/** Fetch and decrypt this server's Auckland Transport subscription key, if one has been set. */
export async function getAtSubscriptionKey(env: Env): Promise<string | null> {
  return getCredential(env.CREDENTIALS_DB, SERVER_SLUG, AT_SUBSCRIPTION_KEY_NAME, env.ENCRYPTION_KEY);
}
