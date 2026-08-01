import { fetchWithBackoff, UpstreamHttpError } from "@iolab/mcp-kit";
import { decryptValue, encryptValue } from "@iolab/credentials";
import { REDDIT_TOKEN_URL, UPSTREAM_NAME } from "./constants.js";
import { InvalidCredentialsError, type RedditCredentials } from "./credentials.js";
import { userAgent } from "./userAgent.js";

/**
 * Seconds shaved off the token's advertised lifetime before it is considered stale.
 *
 * Reddit issues app-only tokens with `expires_in: 3600`. Caching for the full hour races the
 * expiry: a token fetched from KV with two seconds left will 401 halfway through a multi-call tool.
 * Five minutes is comfortably longer than any single tool invocation.
 */
const EXPIRY_MARGIN_SECONDS = 300;

/** KV's minimum accepted `expirationTtl`. A margin larger than the lifetime would floor to this. */
const MIN_KV_TTL_SECONDS = 60;

type CachedToken = { token: string; expiresAtMs: number };

/**
 * The token endpoint answered 200 but without a token — a contract break rather than an HTTP
 * failure, so it needs its own type to be mappable to an actionable tool error.
 */
export class NoAccessTokenError extends Error {
  constructor() {
    super("Reddit's token endpoint returned a success response containing no access_token");
    this.name = "NoAccessTokenError";
  }
}

/**
 * Cache key for the access token.
 *
 * Hashed, and derived from the client *id* only — never the secret. The id is not itself sensitive,
 * but MCP_CACHE is one KV namespace shared by all ten servers in this collection, so the key is
 * namespaced under `reddit:token:` and carries no recoverable credential material.
 *
 * The *value* it points at is protected separately: see `readCachedToken`.
 */
async function tokenCacheKey(clientId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientId));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `reddit:token:${hex.slice(0, 32)}`;
}

/**
 * Read the cached token, decrypting it.
 *
 * The cached value is a live bearer credential, so it is encrypted at rest with the same
 * AES-256-GCM key and helpers that protect the client secret in D1. Without that, read access to
 * the shared KV namespace alone would yield a usable token for the best part of an hour, while the
 * same access against D1 yields only ciphertext — an asymmetry with no justification, given the
 * whole credential design of this repo rests on never having a secret at rest in the clear. The
 * cost is one AES-GCM operation per cache hit.
 *
 * Any failure — missing, corrupt, undecryptable, or expired — is a cache miss rather than an
 * error, mirroring `cached()`'s treatment of a corrupt entry. A cache read must never be able to
 * break a request that could simply mint a new token.
 */
async function readCachedToken(env: Env, key: string): Promise<string | null> {
  const raw = await env.MCP_CACHE.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(await decryptValue(raw, env.ENCRYPTION_KEY)) as CachedToken;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    if (typeof parsed.expiresAtMs !== "number" || parsed.expiresAtMs <= Date.now()) return null;
    return parsed.token;
  } catch {
    return null;
  }
}

/**
 * Mint a fresh app-only access token via the OAuth 2.0 `client_credentials` grant.
 *
 * This is Reddit's documented "Application Only OAuth" flow for confidential clients (script and
 * web app types). No refresh token is issued, so expiry is handled by re-minting rather than
 * refreshing.
 */
async function mintToken(creds: RedditCredentials): Promise<CachedToken> {
  let basic: string;
  try {
    basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
  } catch {
    // btoa throws on any code point above U+00FF. Reddit's ids and secrets are ASCII, so this only
    // happens when a credential was mis-pasted (a smart quote, say) — which is a credentials
    // problem, and deserves the credentials message rather than an opaque InvalidCharacterError.
    throw new InvalidCredentialsError(400);
  }

  const response = await fetchWithBackoff(
    REDDIT_TOKEN_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent(creds.username),
      },
      body: "grant_type=client_credentials",
    },
    {
      // Retry a rate-limited or broken token endpoint the same way data requests are retried — a
      // transient blip here otherwise hard-fails all five tools. But never retry 401/403: those
      // mean the stored credentials are wrong, and repeating the call only burns the login quota
      // and delays an error the operator has to fix by hand.
      retryOn: (res) => (res ? res.status === 429 || res.status >= 500 : true),
    },
  );

  // 401 here means the stored id/secret are wrong or the app was deleted — an operator-fixable
  // configuration problem, not a transient upstream blip. 403 is what Reddit returns when the app
  // exists but is not permitted to use this grant (wrong app type). Both need the same "go check
  // your credentials" message, and neither should be retried.
  if (response.status === 401 || response.status === 403) {
    throw new InvalidCredentialsError(response.status);
  }
  // UpstreamHttpError rather than a bare Error, so mapRedditError recognises it and every tool
  // reports a transient token-endpoint failure as an actionable tool error instead of letting an
  // unmapped exception escape as an opaque protocol error.
  if (!response.ok) {
    throw new UpstreamHttpError(UPSTREAM_NAME, response);
  }

  const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new NoAccessTokenError();
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return { token: body.access_token, expiresAtMs: Date.now() + expiresIn * 1000 };
}

/**
 * Get a usable access token, minting and caching one when necessary.
 *
 * Pass `forceRefresh` after a 401 on a data request to bypass the cache and overwrite it. Two
 * concurrent callers can both miss and both mint; that is deliberately not locked. Reddit keeps
 * previously-issued tokens valid, so the loser of the write race simply uses its own equally-valid
 * token, and a lock would cost more than the duplicate mint it avoids.
 */
export async function getAccessToken(env: Env, creds: RedditCredentials, forceRefresh = false): Promise<string> {
  const key = await tokenCacheKey(creds.clientId);

  if (!forceRefresh) {
    const cached = await readCachedToken(env, key);
    if (cached) return cached;
  }

  const minted = await mintToken(creds);

  // Expire the cache entry ahead of the token itself, and never write a TTL below KV's floor.
  const lifetimeSeconds = Math.floor((minted.expiresAtMs - Date.now()) / 1000);
  const ttl = Math.max(MIN_KV_TTL_SECONDS, lifetimeSeconds - EXPIRY_MARGIN_SECONDS);

  // The recorded expiry is the *earlier* of the KV TTL and the token's own lifetime — not simply
  // the TTL. For a token shorter-lived than the 60-second KV floor, clamping the TTL upward would
  // otherwise record an expiry beyond the point the token actually dies, and hand out a dead token
  // until the 401 path rescued it. Reddit documents 3600, so this is a guard, not a live concern.
  const expiresAtMs = Math.min(Date.now() + ttl * 1000, minted.expiresAtMs);
  const stored: CachedToken = { token: minted.token, expiresAtMs };
  await env.MCP_CACHE.put(key, await encryptValue(JSON.stringify(stored), env.ENCRYPTION_KEY), { expirationTtl: ttl });

  return minted.token;
}
