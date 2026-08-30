# Deploying your own instance

This collection is built for one operator (you) running your own private fleet of MCP servers,
served from **one Cloudflare Worker** (`apps/gateway`) on **one hostname**. There's no multi-tenant
mode — every resource below (D1 database, KV namespace, Access application, domain) is yours alone.
Expect this to take 20-30 minutes the first time.

## Prerequisites

- A [Cloudflare](https://dash.cloudflare.com/sign-up) account (the free plan is enough — the
  gateway's bundle size and startup time both sit comfortably within Free-plan limits).
- A domain, or a subdomain you control, added to Cloudflare as a zone (e.g. `mcp.yourdomain.com`). You
  don't need a dedicated domain — a subdomain of one you already manage on Cloudflare works fine.
- Node.js 22+ and [pnpm](https://pnpm.io/installation) (`corepack enable pnpm` if you have Node's
  corepack available).
- The [Cloudflare Zero Trust](https://developers.cloudflare.com/cloudflare-one/) dashboard enabled for
  your account (any account gets a free Zero Trust org the first time you visit
  `https://dash.cloudflare.com/?to=/:account/access` or `<your-team-name>.cloudflareaccess.com`) and at
  least one identity provider configured — the simplest is the built-in **One-time PIN** (email OTP),
  which needs no external IdP setup.

## 1. Clone and install

```bash
git clone https://github.com/bradwindy/nz-mcp-collection.git
cd nz-mcp-collection
pnpm install
pnpm exec wrangler login
```

## 2. Provision your own Cloudflare resources

The gateway binds one D1 database, one shared cache KV namespace, and one **new** OAuth KV
namespace. Create your own — do **not** reuse the IDs already in this repo's
`apps/gateway/wrangler.jsonc`, those point at the original deployment's resources and you have no
access to them.

```bash
pnpm exec wrangler d1 create nz-mcp-credentials
# → note the returned database_id

pnpm exec wrangler kv namespace create nz-mcp-cache
# → note the returned id

pnpm exec wrangler kv namespace create OAUTH_KV
# → note the returned id — this MUST be a fresh namespace, not reused from anywhere else. One
# shared authorization server now covers every registered server, so one token store is correct;
# starting clean means every client re-authorizes once, which is what you want during a cutover.

# Apply the credentials schema to your new database:
pnpm exec wrangler d1 execute nz-mcp-credentials --remote --file=packages/credentials/schema.sql
```

Now update `apps/gateway/wrangler.jsonc` — replace:
- `kv_namespaces[0].id` (`MCP_CACHE`) with your cache KV namespace id
- `kv_namespaces[1].id` (`OAUTH_KV`) with your **new** OAuth KV namespace id (the committed value is
  a placeholder, `REPLACE_WITH_NEW_GATEWAY_OAUTH_KV_NAMESPACE_ID` — it does not point at a real
  namespace and deploy will fail until you replace it)
- `d1_databases[0].database_id` with your D1 database id
- `routes[0].pattern` hostname with your own subdomain, e.g. `mcp.yourdomain.com`

## 3. Generate your secrets

```bash
# ENCRYPTION_KEY: 32 random bytes, base64-encoded (AES-256-GCM key for the credential store)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# MCP_SHARED_TOKEN: the bearer token every MCP client must present
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Save both somewhere safe (a password manager, not a file in this repo) — you'll paste them in step 6,
once for the whole gateway (not once per server, as in the old per-server-Worker layout).

`BASE_DOMAIN` and `ACCESS_EMAIL` carry your domain and identity — deliberately never written to any
file in this repo (not even `wrangler.jsonc`), since a fork's domain/email are that operator's own:
- `PORTAL_URL` (secret): the full URL of this deployed gateway, e.g. `https://mcp.yourdomain.com` —
  used only to build the link in "missing credential" error messages.
- `BASE_DOMAIN` (secret): your bare base domain, e.g. `yourdomain.com` — combined with each server's
  manifest `pathPrefix` to render live links on the dashboard and Connect page.
- `ACCESS_EMAIL` (secret): your email — the one operator identity the gateway accepts, both for
  `/authorize` and for the portal's `/admin/*` routes.

## 4. Create the Cloudflare Access application, scoped to `/authorize` only

**One** self-hosted Access application covers the whole gateway — `/authorize` is the only path
actually gated by Cloudflare Access at the infrastructure level:

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Application domain: your gateway's hostname **and path**, e.g. `mcp.yourdomain.com/authorize` —
   not the bare hostname. Scoping to the path is what keeps `/{slug}/mcp`, `/token`, `/register`, and
   the `.well-known` documents public, since those are called server-to-server by claude.ai and
   Claude Code with no interactive login possible.
3. Add a policy: Action **Allow**, Include **Emails** → your email address (the same one you'll set
   as `ACCESS_EMAIL`).
4. Save, then copy the application's **Audience (AUD) tag** (shown on the application's overview
   page) — this is `ACCESS_AUD` below.

**This step is the one place a mistake breaks everything at once.** An Access application scoped to
the whole hostname (instead of just `/authorize`) intercepts `/{slug}/mcp`, `/token`, and `/register`
too — those must stay reachable without an interactive login.

| Path | Must be |
|---|---|
| `/authorize` | Behind Access (interactive login only) — the only infrastructure-level gate |
| `/{slug}/mcp` (e.g. `/nz-govt/mcp`) | Public (bearer token **or** OAuth token checked in application code) |
| `/token`, `/register` | Public (machine-to-machine) |
| `/.well-known/oauth-authorization-server` | Public (RFC 8414 discovery) |
| `/.well-known/oauth-protected-resource*` | Public (RFC 9728 discovery, per path) |
| `/admin/*` (the portal's dashboard/Connect/credential forms) | **Authorized in code**, not by a separate Access application — see below |
| `/` (public landing page) | Public, deliberately holds no server list, no credential status, no secrets |

The portal used to be its own Worker on its own hostname, entirely covered by Access at the
infrastructure level. On the shared gateway hostname that's no longer possible — the same hostname
must also keep `/token`/`/register`/`/.well-known/*` public. So `/admin/*` is protected **in code**
instead: `apps/portal/src/app.ts` runs `verifyAccessJwt` (the same check `/authorize` uses, from
`@iolab/mcp-kit`) against every `/admin/*` request, checking for a valid Access session cookie
(`CF_Authorization`, set domain-wide once you've completed the Access login at `/authorize` — the
JWT's signature is what's actually verified, not just its presence). A routing mistake here is a 403
from that check, not a credential leak.

## 5. Set the gateway's secrets

```bash
cd apps/gateway
pnpm exec wrangler types      # generates worker-configuration.d.ts from wrangler.jsonc

printf '%s' "<your MCP_SHARED_TOKEN>" | pnpm exec wrangler secret put MCP_SHARED_TOKEN
printf '%s' "<your ENCRYPTION_KEY>"   | pnpm exec wrangler secret put ENCRYPTION_KEY
printf '%s' "https://mcp.yourdomain.com" | pnpm exec wrangler secret put PORTAL_URL
printf '%s' "yourdomain.com"          | pnpm exec wrangler secret put BASE_DOMAIN
printf '%s' "you@yourdomain.com"      | pnpm exec wrangler secret put ACCESS_EMAIL
printf '%s' "<your-team-name>.cloudflareaccess.com" | pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN
printf '%s' "<the /authorize Access application's AUD tag>" | pnpm exec wrangler secret put ACCESS_AUD

pnpm exec wrangler deploy
cd ../..
```

This is the **entire** secrets table now — one Worker, set once, not once per server:

| Secret | Purpose |
|---|---|
| `MCP_SHARED_TOKEN` | Static bearer token (Claude Code), works identically at every `/{slug}/mcp` path |
| `PORTAL_URL` | Link in missing-credential error messages |
| `ENCRYPTION_KEY` | Encrypt/decrypt upstream API keys |
| `BASE_DOMAIN` | Builds live URLs on the dashboard and Connect page |
| `ACCESS_TEAM_DOMAIN` | Verify the Access JWT's issuer (shared by `/authorize` and `/admin/*`) |
| `ACCESS_AUD` | Verify the Access JWT's audience |
| `ACCESS_EMAIL` | The one operator email `/authorize` and `/admin/*` accept |
| `DISABLE_RESOURCE_ENFORCEMENT` | Leave unset — see §7 below |

### If a custom domain's certificate gets stuck on "pending validation"

If your zone doesn't have [Total TLS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/)
enabled, the advanced certificate Cloudflare issues for a new hostname needs `_acme-challenge` TXT
records that aren't always created automatically. Check status:

```bash
curl -s "https://api.cloudflare.com/client/v4/zones/<zone_id>/ssl/certificate_packs?status=all" \
  -H "Authorization: Bearer <your Cloudflare API token>" | jq '.result[] | select(.hosts | index("<your-hostname>"))'
```

If `status` is `pending_validation`, its `validation_records` array has the exact `txt_name`/`txt_value`
pairs to add as TXT records in your zone's DNS. Re-check after a minute or two — it flips to `active`
once Cloudflare's CA validates them. Enabling Total TLS on your zone avoids this entirely.

## 6. Get your API keys

See [API_KEYS.md](API_KEYS.md) — 14 of the 24 upstream APIs need no key and work immediately; the rest
you enter through your deployed gateway's dashboard (`https://mcp.yourdomain.com/admin`).

## 7. Connect to Claude

```bash
claude mcp add --transport http nz-govt-mcp https://mcp.yourdomain.com/nz-govt/mcp \
  --header "Authorization: Bearer <your MCP_SHARED_TOKEN>"
```

Repeat per server (`nz-govt`, `nz-culture`, `nz-stats`, `nz-geo`, `nz-environment`, `nz-transport`,
`nz-markets`), or use the **Connect** page at `https://mcp.yourdomain.com/admin/connect` (behind
Cloudflare Access), which renders the exact command for every server with the token already filled
in.

**claude.ai** (and Claude mobile) add custom connectors through an interactive browser login instead
— its first-class path is OAuth 2.1 + PKCE with Dynamic Client Registration, which every registered
server supports out of the box now (there's no more per-server opt-in step): Settings → Connectors →
**Add custom connector** → enter `https://mcp.yourdomain.com/nz-govt/mcp` (or any other registered
`/{slug}/mcp` URL) → Claude opens a browser tab, Cloudflare Access prompts you to sign in, then a
one-time consent page shows which client is asking to connect — click **Approve** — and you're
redirected back into claude.ai as connected. (This consent click is a deliberate step, not a bug: DCR
lets any client self-register, so skipping it would let a crafted link silently grant access to an
already-logged-in browser.)

**Team/Enterprise account:** an admin can add the connector the same way, so every member of the team
sees it — but only the single operator email in `ACCESS_EMAIL` can actually complete the login. This
collection is built for one operator; it does not support authorizing multiple distinct users.

### One authorization server, one token store, per-path audience enforcement

Collapsing eight Workers into one removes the isolation the old layout had "for free": each server
used to have its **own** `OAUTH_KV`, so a leak or bug in one server's OAuth storage couldn't touch
another's issued tokens. One shared authorization server means one shared token store now — the
`/authorize` endpoint mitigates this by requiring an RFC 8707 `resource` parameter naming exactly one
registered server, and rejecting a token whose `resource` doesn't match the server it's used against
(cross-origin, origin-only, missing, multiple, or unregistered-path `resource` values are all
rejected with a 400 before a grant is even created). claude.ai sends this parameter; this is not
something you need to configure. If a real client turns out not to send it, set
`DISABLE_RESOURCE_ENFORCEMENT=true` via `wrangler secret put` as a cutover escape hatch — but every
`/authorize` request logs the raw `resource` value(s) it observed regardless, specifically so you can
confirm the assumption from Workers Logs before ever needing that escape hatch.

## 8. Verification / troubleshooting

```bash
# Discovery documents (should both return 200 with JSON, no auth required):
curl -s https://mcp.yourdomain.com/.well-known/oauth-authorization-server | jq
curl -s https://mcp.yourdomain.com/.well-known/oauth-protected-resource/nz-govt/mcp | jq

# Unauthenticated /nz-govt/mcp should 401 with a WWW-Authenticate challenge pointing at that
# server's own protected-resource metadata (not a shared/generic one):
curl -sI https://mcp.yourdomain.com/nz-govt/mcp -X POST | grep -i www-authenticate

# /authorize with no Access session should 302, redirecting to your team's Access login page —
# confirmed live: Access intercepts it before the Worker ever runs when the app is configured
# correctly. A bare 200 here (the consent page, unauthenticated) means the Access app isn't
# actually covering this path:
curl -sI https://mcp.yourdomain.com/authorize | grep -i "^HTTP\|^location"

# /admin (the portal dashboard) should also 403 with no Access session — verified in code, not by
# a separate Access application:
curl -sI https://mcp.yourdomain.com/admin

# / (the public landing page) should 200 with no auth at all, and mention nothing operational:
curl -s https://mcp.yourdomain.com/ | grep -c "iolab MCP fleet"
```

Common failures:

- **claude.ai never prompts a login, or `/{slug}/mcp` calls with a bearer token also 401** — the
  Access application is scoped too broadly (covers more than `/authorize`). Fix the application
  domain in step 4 to include the exact `/authorize` path.
- **`invalid_client` / `redirect_uri mismatch` during the OAuth handshake** — claude.ai registers
  itself as a new DCR client on first connection; if you removed and re-added the connector, it
  registers a new client each time. Expected, not an error, unless it recurs on every request.
- **A second connector's authorization silently breaks a first one that was working** — this is
  exactly the bug `revokeExistingGrants: false` in `packages/mcp-kit/src/oauth.ts` exists to prevent
  (the OAuth library's default revokes every prior grant for the same user+client on a new grant,
  which would otherwise fire the moment claude.ai reuses one DCR client_id across two of your
  connectors on this one shared authorization server). If you see this, it's a regression — file an
  issue, don't just re-authorize and move on.
- **403 with a valid-looking Access login** — the JWT's `email` claim doesn't match your
  `ACCESS_EMAIL` secret exactly, or `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN` don't match the `/authorize`
  Access application's own values.
- **Claude Code stops working after adding a new server** — it shouldn't: the bearer bypass in
  `buildMultiServerOAuthWorker` checks the exact `MCP_SHARED_TOKEN` header, per registered path,
  before the OAuth provider ever runs. If it did break, confirm you didn't also rotate
  `MCP_SHARED_TOKEN`.
- **Every tool call on one connector fails with a credential decryption error while the same server
  works via another connection** — the failing connector is almost certainly pointing at a stale
  deployment that shares the credentials D1 but carries a different `ENCRYPTION_KEY` secret. This
  happened in production (August 2026): the pre-gateway per-server Workers
  (`nz-stats-mcp`, `nz-culture-mcp`, …, `nz-mcp-portal` at `{slug}.mcp.<domain>`) were left deployed
  after the collapse to one gateway, and a claude.ai connector created before the collapse kept
  talking to its old hostname. Every tool call surfaced a raw AES-GCM `OperationError` (now a
  `CredentialDecryptionError` with an actionable message — see `packages/credentials`). Fix: delete
  the stale Workers (`wrangler delete --name <worker>`; the shared `MCP_CACHE` KV and credentials D1
  are separate resources and survive), then remove and re-add the connector against
  `https://mcp.<domain>/{slug}/mcp`. After any layout change, `wrangler deployments list --name
  <old-worker>` is the quick way to check for zombies.
- **"Forbidden: missing or invalid CSRF token" when clicking Approve** — the consent page's cookie
  (`__Host-OAUTH_CSRF`) is 10 minutes and single-flow; this fires if you took too long, opened the
  consent link in a second tab/browser, or the browser blocked the `__Host-` cookie (requires HTTPS
  and no `Domain` attribute — normal on a Cloudflare custom domain, but fails over plain HTTP in
  local `wrangler dev` testing). Every rejection response includes a short `(ref: ...)` — grep Workers
  Logs for `[authorize:<ref>]` to see the whole flow (render, submit, outcome) as one correlated
  sequence.

## Updating an existing deployment

```bash
cd apps/gateway
pnpm exec wrangler types && pnpm exec wrangler deploy
```

Bindings and secrets persist across deploys — you only need to redo steps 2-4 once, at initial
setup.

## Optional: deploy automatically on push to main

`.github/workflows/ci.yml` has a `deploy` job that redeploys the gateway whenever a push lands on
`main` (after the build/lint/typecheck/test job passes). It's disabled by default in the sense that
it fails fast without these repo secrets — add them under **Settings → Secrets and variables →
Actions**:

- `CLOUDFLARE_API_TOKEN` — a token scoped to **Workers Scripts: Edit** (account) and
  **Workers Routes: Edit** (all zones); create one at **My Profile → API Tokens → Create Token**.
- `CLOUDFLARE_ACCOUNT_ID` — from `wrangler whoami`.
- `DEPLOY_DOMAIN` — your bare base domain (e.g. `yourdomain.com`), substituted into
  `apps/gateway/wrangler.jsonc`'s `yourdomain.com` route placeholder at deploy time via
  `scripts/deploy.sh` (see that script for the exact mechanism). Never committed anywhere in this
  repo.

This job only deploys the gateway's Worker code and its custom domain route — it never touches
secrets, which persist from the manual initial setup above and don't need to be reset on every
deploy.
