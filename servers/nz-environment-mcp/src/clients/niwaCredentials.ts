import { getCredential } from "@iolab/credentials";
import { NIWA_API_KEY_NAME, SERVER_SLUG } from "../constants.js";

/** Look up the shared NIWA API key from the encrypted credentials store. Null if unset. */
export async function getNiwaApiKey(env: Env): Promise<string | null> {
  return getCredential(env.CREDENTIALS_DB, SERVER_SLUG, NIWA_API_KEY_NAME, env.ENCRYPTION_KEY);
}
