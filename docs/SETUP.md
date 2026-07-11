# Deploying your own instance

This collection is built for one operator (you) running your own private fleet of MCP servers. There's
no multi-tenant mode — every resource below (D1 database, KV namespace, Access app, domain) is yours
alone. Expect this to take 20-30 minutes the first time.

## Prerequisites

- A [Cloudflare](https://dash.cloudflare.com/sign-up) account (the free plan is enough).
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

Every server and the portal share one D1 database and one KV namespace. Create your own — do **not**
reuse the IDs already in this repo's `wrangler.jsonc` files, those point at the original deployment's
resources and you have no access to them.

```bash
pnpm exec wrangler d1 create nz-mcp-credentials
# → note the returned database_id

pnpm exec wrangler kv namespace create nz-mcp-cache
# → note the returned id

# Apply the credentials schema to your new database:
pnpm exec wrangler d1 execute nz-mcp-credentials --remote --file=packages/credentials/schema.sql
```

Now update **every** `wrangler.jsonc` under `servers/*/` and `apps/portal/` — replace:
- `kv_namespaces[0].id` with your KV namespace id
- `d1_databases` (or `CREDENTIALS_DB` binding, on servers that have one) with your D1 database id
- the `routes[0].pattern` hostname with your own subdomain, e.g. `nz-govt.mcp.yourdomain.com`

A quick way to see every place that needs editing:

```bash
grep -rn "bac29680ac6a419284c9a522b241ae8a\|5c6248bf-f226-46b0-aa2b-a6a9bc2ca790\|yourdomain.com" \
  servers/*/wrangler.jsonc apps/portal/wrangler.jsonc
```

## 3. Generate your secrets

Two secrets are shared identically across the portal and every server:

```bash
# ENCRYPTION_KEY: 32 random bytes, base64-encoded (AES-256-GCM key for the credential store)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# MCP_SHARED_TOKEN: the bearer token every MCP client must present
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Save both somewhere safe (a password manager, not a file in this repo) — you'll paste them in the next
step, once per Worker.

Three more secrets carry your domain and identity — deliberately never written to any file in this
repo (not even `wrangler.jsonc`), since a fork's domain/email are that operator's own:
- `PORTAL_URL` (every server): the full URL of your deployed portal, e.g. `https://mcp.yourdomain.com`
  — used only to build the link in "missing credential" error messages.
- `BASE_DOMAIN` (portal only): your bare base domain, e.g. `yourdomain.com` — combined with each
  server's manifest entry to render live links on the dashboard and Connect page.
- `ACCESS_EMAIL` (portal only): your email — shown as display text on the Connect page as a reminder
  of who Cloudflare Access allows through; not itself an access control.

## 4. Set up Cloudflare Access for the portal

The portal (not the MCP servers — see [README.md](../README.md#architecture) for why) is gated by
Cloudflare Access, restricted to your own email:

1. In the Cloudflare dashboard, go to **Zero Trust → Access → Applications → Add an application →
   Self-hosted**.
2. Application domain: your portal's hostname (e.g. `mcp.yourdomain.com`).
3. Add a policy: Action **Allow**, Include **Emails** → your email address.
4. Save. (If you'd rather not manage this per the dashboard, the Cloudflare API
   [`POST /accounts/{account_id}/access/apps`](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/)
   does the same thing — see this repo's own setup for the exact request shape.)

## 5. Deploy every server and the portal

Repeat for each of `nz-govt-mcp`, `nz-culture-mcp`, `nz-stats-mcp`, `nz-geo-mcp`, `nz-environment-mcp`,
`nz-transport-mcp`, `nz-markets-mcp`, and `apps/portal`:

```bash
cd servers/nz-govt-mcp   # (or apps/portal)
pnpm exec wrangler types      # generates worker-configuration.d.ts from your wrangler.jsonc
pnpm exec wrangler deploy

# Set secrets (every Worker needs MCP_SHARED_TOKEN and PORTAL_URL; every Worker EXCEPT
# nz-govt-mcp also needs ENCRYPTION_KEY, since nz-govt-mcp is the one server needing no
# upstream credentials):
printf '%s' "<your MCP_SHARED_TOKEN>" | pnpm exec wrangler secret put MCP_SHARED_TOKEN
printf '%s' "<your ENCRYPTION_KEY>"  | pnpm exec wrangler secret put ENCRYPTION_KEY
printf '%s' "https://mcp.yourdomain.com" | pnpm exec wrangler secret put PORTAL_URL

cd ../..
```

The portal needs `ENCRYPTION_KEY`, `MCP_SHARED_TOKEN`, `BASE_DOMAIN`, and `ACCESS_EMAIL`, but not
`PORTAL_URL` (it has no `/mcp` endpoint to gate, and doesn't link to itself). It reads `MCP_SHARED_TOKEN`
to render the live, ready-to-paste `claude mcp add` commands on its **Connect** page — without it, that
page renders each command with the token missing:

```bash
cd apps/portal
printf '%s' "<your MCP_SHARED_TOKEN>" | pnpm exec wrangler secret put MCP_SHARED_TOKEN
printf '%s' "<your ENCRYPTION_KEY>"   | pnpm exec wrangler secret put ENCRYPTION_KEY
printf '%s' "yourdomain.com"          | pnpm exec wrangler secret put BASE_DOMAIN
printf '%s' "you@yourdomain.com"      | pnpm exec wrangler secret put ACCESS_EMAIL
cd ../..
```

### If a custom domain's certificate gets stuck on "pending validation"

If your zone doesn't have [Total TLS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/total-tls/)
enabled, the advanced certificate Cloudflare issues for each new subdomain needs `_acme-challenge` TXT
records that aren't always created automatically. Check status:

```bash
# Find the cert pack covering your new hostname:
curl -s "https://api.cloudflare.com/client/v4/zones/<zone_id>/ssl/certificate_packs?status=all" \
  -H "Authorization: Bearer <your Cloudflare API token>" | jq '.result[] | select(.hosts | index("<your-hostname>"))'
```

If `status` is `pending_validation`, its `validation_records` array has the exact `txt_name`/`txt_value`
pairs to add as TXT records in your zone's DNS (dashboard: **DNS → Records → Add record**, type TXT).
Re-check after a minute or two — it flips to `active` once Cloudflare's CA validates them. Enabling Total
TLS on your zone once avoids this for every subdomain you add afterward.

## 6. Get your API keys

See [API_KEYS.md](API_KEYS.md) — 14 of the 24 upstream APIs need no key and work immediately; the rest
you enter through your deployed portal.

## 7. Connect to Claude

```bash
claude mcp add --transport http nz-govt-mcp https://nz-govt.mcp.yourdomain.com/mcp \
  --header "Authorization: Bearer <your MCP_SHARED_TOKEN>"
```

Repeat per server, or use the **Connect** page on your deployed portal, which renders the exact command
for every server with the token already filled in.

## 8. OAuth for claude.ai (optional)

Claude Code uses the static `MCP_SHARED_TOKEN` above and needs nothing further. **claude.ai** (and
Claude mobile), however, add custom connectors through an interactive browser login — its first-class
path is OAuth 2.1 + PKCE with Dynamic Client Registration. Every server in this collection can do both
at once: the static bearer token keeps working unchanged, and each server also runs its own OAuth
authorization/resource server, gated by Cloudflare Access. Do this once per server you want to add to
claude.ai; skip it entirely for servers you only ever use from Claude Code.

### 8.1 Create the OAuth KV namespace (per server)

Each server stores its OAuth tokens/grants/DCR clients in its own KV namespace — deliberately *not*
shared with `MCP_CACHE` or across servers, so a leak or bug in one server's OAuth storage can't touch
another's issued tokens.

```bash
pnpm exec wrangler kv namespace create OAUTH_KV
# → note the returned id
```

Paste the id into that server's `wrangler.jsonc`, replacing the placeholder:

```jsonc
{ "binding": "OAUTH_KV", "id": "REPLACE_WITH_OAUTH_KV_NAMESPACE_ID" },
```

Repeat for every server you're enabling OAuth on — each needs its **own** namespace, not one shared
across the fleet.

### 8.2 Find your Access team domain

Cloudflare Zero Trust dashboard → **Settings → Custom Pages** (or any Zero Trust page — the team domain
is shown in the URL and in **Settings → General**): `<your-team-name>.cloudflareaccess.com`. This is the
same team you already used for the portal's Access app in step 4. This value is `ACCESS_TEAM_DOMAIN`
below, identical for every server.

### 8.3 Create a self-hosted Access application per server, scoped to `/authorize` only

For each server you're enabling OAuth on:

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. Application domain: the server's hostname **and path**, e.g.
   `nz-govt.mcp.yourdomain.com/authorize` — not the bare hostname. Scoping to the path is what keeps
   `/mcp`, `/token`, `/register`, and the `.well-known` documents public.
3. Add a policy: Action **Allow**, Include **Emails** → your email address (the same one you'll set as
   `ACCESS_EMAIL`).
4. Save, then copy the application's **Audience (AUD) tag** (shown on the application's overview page) —
   this is `ACCESS_AUD` below, **different for every server** (each is its own Access application).

**This step is the one place a mistake breaks both claude.ai and Claude Code at once.** An Access
application scoped to the whole hostname (instead of just `/authorize`) intercepts `/mcp`, `/token`, and
`/register` too — those must stay reachable without an interactive login, since claude.ai and Claude Code
both call them server-to-server.

| Path | Must be |
|---|---|
| `/authorize` | Behind Access (interactive login only) |
| `/mcp` | Public (bearer token **or** OAuth token checked in application code) |
| `/token` | Public (OAuth token exchange, machine-to-machine) |
| `/register` | Public (Dynamic Client Registration, machine-to-machine) |
| `/.well-known/oauth-authorization-server` | Public (RFC 8414 discovery) |
| `/.well-known/oauth-protected-resource*` | Public (RFC 9728 discovery) |

### 8.4 Set the secrets (per server)

Alongside the existing `MCP_SHARED_TOKEN` / `PORTAL_URL` / `ENCRYPTION_KEY`, every server with OAuth
enabled needs three more:

```bash
cd servers/nz-govt-mcp   # repeat per server
printf '%s' "<your-team-name>.cloudflareaccess.com" | pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN
printf '%s' "<this server's Access application AUD tag>" | pnpm exec wrangler secret put ACCESS_AUD
printf '%s' "you@yourdomain.com" | pnpm exec wrangler secret put ACCESS_EMAIL
cd ../..
```

Full secrets table for a server with OAuth enabled:

| Secret | Same across every server? | Purpose |
|---|---|---|
| `MCP_SHARED_TOKEN` | Yes | Static bearer token (Claude Code) |
| `PORTAL_URL` | Yes | Link in missing-credential error messages |
| `ENCRYPTION_KEY` | Yes (every server except `nz-govt-mcp`) | Decrypt upstream API keys |
| `ACCESS_TEAM_DOMAIN` | Yes | Verify the Access JWT's issuer |
| `ACCESS_AUD` | **No — per server**, from that server's own Access app | Verify the Access JWT's audience |
| `ACCESS_EMAIL` | Yes | The one operator email `/authorize` accepts |

### 8.5 Deploy

```bash
cd servers/nz-govt-mcp && pnpm exec wrangler types && pnpm exec wrangler deploy && cd ../..
# or, once every server is ready:
pnpm run deploy:all
```

### 8.6 Add the connector in claude.ai

**Personal account:** Settings → Connectors → **Add custom connector** → enter
`https://nz-govt.mcp.yourdomain.com/mcp` → Claude opens a browser tab, Cloudflare Access prompts you to
sign in (email OTP or whichever identity provider you configured in step 4), then a one-time consent page
shows which client is asking to connect — click **Approve** — and you're redirected back into claude.ai
as connected. (This consent click is a deliberate step, not a bug: DCR lets any client self-register, so
skipping it would let a crafted link silently grant access to an already-logged-in browser.)

**Team/Enterprise account:** an admin can add the connector the same way under the organization's
**Settings → Connectors**, so every member of the team sees it — but only the single operator email in
`ACCESS_EMAIL` can actually complete the login: `verifyAccessJwt` checks the Access JWT's email against
that one configured value, regardless of how many emails your Access policy itself allows through. This
collection is built for one operator (see the top of this doc); it does not support authorizing multiple
distinct users per server.

The portal's **Connect** page shows this same `/mcp` URL next to the existing `claude mcp add` command
for each server, so you don't need to reconstruct it by hand.

### 8.7 Verification / troubleshooting

```bash
# Discovery documents (should both return 200 with JSON, no auth required):
curl -s https://nz-govt.mcp.yourdomain.com/.well-known/oauth-authorization-server | jq
curl -s https://nz-govt.mcp.yourdomain.com/.well-known/oauth-protected-resource/mcp | jq

# Unauthenticated /mcp should 401 with a WWW-Authenticate challenge pointing at the resource metadata:
curl -sI https://nz-govt.mcp.yourdomain.com/mcp -X POST | grep -i www-authenticate

# /authorize with no Access session should 403 (Access blocks it before your Worker even runs, if
# the Access app is configured correctly — a 200/302 here without ever prompting a login means the
# Access app isn't actually covering this path):
curl -sI https://nz-govt.mcp.yourdomain.com/authorize
```

Common failures:

- **claude.ai never prompts a login, or `/mcp` calls with a bearer token also 401** — the Access
  application is scoped too broadly (covers more than `/authorize`). Fix the application domain in step
  8.3 to include the exact `/authorize` path.
- **`invalid_client` / `redirect_uri mismatch` during the OAuth handshake** — claude.ai registers itself
  as a new DCR client on first connection; if you removed and re-added the connector, it registers a new
  client each time. This is expected and not an error unless it recurs on every request.
- **`resource` in `/.well-known/oauth-protected-resource/mcp` doesn't match the URL you entered in
  claude.ai** — the provider derives `resource` from the request's own hostname automatically; this only
  happens if you're behind an unexpected proxy/redirect rewriting the Host header before reaching the
  Worker. On a plain Cloudflare custom domain this shouldn't occur.
- **403 with a valid-looking Access login** — the JWT's `email` claim doesn't match your `ACCESS_EMAIL`
  secret exactly, or `ACCESS_AUD` is the wrong application's AUD tag (double check you copied the AUD
  from *this* server's Access application, not the portal's or another server's).
- **Claude Code stops working after adding OAuth** — it shouldn't: the bypass in `buildOAuthMcpWorker`
  checks for the exact `MCP_SHARED_TOKEN` bearer header before the OAuth provider ever runs. If it did
  break, confirm you didn't also rotate `MCP_SHARED_TOKEN` as part of this change.
- **"Forbidden: missing or invalid CSRF token" when clicking Approve** — the consent page's cookie
  (`__Host-OAUTH_CSRF`) is 5 minutes and single-flow; this fires if you took too long, opened the
  consent link in a second tab/browser than the one that requested it, or the browser blocked the
  cookie (the `__Host-` prefix requires HTTPS and no `Domain` attribute — normal on a Cloudflare custom
  domain, but would fail over plain HTTP in local `wrangler dev` testing). Reload `/authorize` and
  approve again from the same browser session.

## Updating an existing deployment

After pulling changes, redeploy the servers that changed:

```bash
cd servers/<name>   # or apps/portal
pnpm exec wrangler types && pnpm exec wrangler deploy
```

Bindings and secrets persist across deploys — you only need to redo steps 2-4 once, at initial setup.

## Optional: deploy automatically on push to main

`.github/workflows/ci.yml` has a `deploy` job that redeploys every server and the portal whenever a
push lands on `main` (after the build/lint/typecheck/test job passes). It's disabled by default in the
sense that it fails fast without these repo secrets — add them under **Settings → Secrets and
variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — a token scoped to **Workers Scripts: Edit** (account) and
  **Workers Routes: Edit** (all zones); create one at **My Profile → API Tokens → Create Token**.
- `CLOUDFLARE_ACCOUNT_ID` — from `wrangler whoami`.
- `DEPLOY_DOMAIN` — your bare base domain (e.g. `yourdomain.com`), substituted into each
  `wrangler.jsonc`'s `yourdomain.com` route placeholder at deploy time via `scripts/deploy.sh` (see that
  script for the exact mechanism). Never committed anywhere in this repo.

This job only deploys Worker code and the custom domain route — it never touches secrets
(`MCP_SHARED_TOKEN`, `ENCRYPTION_KEY`, `PORTAL_URL`, `BASE_DOMAIN`, `ACCESS_EMAIL`, and, on servers with
OAuth enabled, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`), which persist from the manual initial setup above
and don't need to be reset on every deploy.
