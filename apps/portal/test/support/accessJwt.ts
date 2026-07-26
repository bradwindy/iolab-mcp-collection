// Subpath import, not the main barrel — see packages/mcp-kit/src/access.ts.
import { __setAccessJwksResolverForTesting } from "@iolab/mcp-kit/access";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { TEST_ACCESS_AUD, TEST_ACCESS_TEAM_DOMAIN } from "./fakeD1.js";

/**
 * Sets up a local keypair as the /admin/* access guard's JWKS source (same seam
 * `@iolab/mcp-kit`'s own OAuth tests use), so route tests can sign a request-passing Access JWT
 * without a real Cloudflare Zero Trust team. Call in `beforeAll`, and `resetAccessJwtTesting()` in
 * `afterAll` to restore the real remote-JWKS resolver.
 */
export async function setUpAccessJwtTesting(): Promise<(email?: string) => Promise<string>> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] });
  __setAccessJwksResolverForTesting(() => jwks);

  return (email = "you@example.com") =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setIssuer(`https://${TEST_ACCESS_TEAM_DOMAIN}`)
      .setAudience(TEST_ACCESS_AUD)
      .setExpirationTime("5m")
      .sign(privateKey);
}

export function resetAccessJwtTesting(): void {
  __setAccessJwksResolverForTesting(undefined);
}
