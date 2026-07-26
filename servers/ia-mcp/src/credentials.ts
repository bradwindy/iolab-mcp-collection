import { getCredential } from "@iolab/credentials";
import { IA_S3_ACCESS_KEY, IA_S3_SECRET_KEY, SERVER_SLUG } from "./constants.js";

/**
 * archive.org's automated-access docs describe an IA-S3 `Authorization: LOW <access>:<secret>`
 * header, and the operator asked for it to be wired in for "higher rate limits." Live testing
 * found no evidence read endpoints (CDX, metadata, search, download) treat it any differently —
 * sending a deliberately invalid key changed nothing, and IA's own docs frame rate limiting
 * around PUTs/DELETEs, not reads. So this is genuinely optional: every tool must work fully
 * without it, and this helper never throws — it returns `null` when unset, and the request
 * builder in clients/http.ts just omits the header entirely in that case.
 */
export async function getOptionalIaS3Credentials(env: Env): Promise<{ access: string; secret: string } | null> {
  const [access, secret] = await Promise.all([
    getCredential(env.CREDENTIALS_DB, SERVER_SLUG, IA_S3_ACCESS_KEY, env.ENCRYPTION_KEY),
    getCredential(env.CREDENTIALS_DB, SERVER_SLUG, IA_S3_SECRET_KEY, env.ENCRYPTION_KEY),
  ]);
  if (!access || !secret) return null;
  return { access, secret };
}
