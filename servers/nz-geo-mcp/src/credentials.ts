import { getCredential } from "@iolab/credentials";
import { SERVER_SLUG } from "./constants.js";

export type LinzCredentialName = "LINZ_API_KEY" | "LINZ_BASEMAPS_API_KEY";

/** Thrown when a required upstream credential has not been configured yet for this server. */
export class MissingCredentialError extends Error {
  constructor(public readonly keyName: LinzCredentialName) {
    super(`Missing credential: ${keyName}`);
    this.name = "MissingCredentialError";
  }
}

/**
 * Fetch and decrypt a required upstream API key from the shared credentials store.
 * Throws MissingCredentialError (caught by tool handlers, mapped to an actionable
 * tool-execution error) if it hasn't been set via the portal yet.
 */
export async function requireLinzCredential(env: Env, keyName: LinzCredentialName): Promise<string> {
  const value = await getCredential(env.CREDENTIALS_DB, SERVER_SLUG, keyName, env.ENCRYPTION_KEY);
  if (!value) throw new MissingCredentialError(keyName);
  return value;
}
