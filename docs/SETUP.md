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
grep -rn "bac29680ac6a419284c9a522b241ae8a\|5c6248bf-f226-46b0-aa2b-a6a9bc2ca790\|mcp.iolab.nz" \
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

# Set secrets (every Worker needs MCP_SHARED_TOKEN; every Worker EXCEPT nz-govt-mcp
# also needs ENCRYPTION_KEY, since nz-govt-mcp is the one server needing no upstream credentials):
printf '%s' "<your MCP_SHARED_TOKEN>" | pnpm exec wrangler secret put MCP_SHARED_TOKEN
printf '%s' "<your ENCRYPTION_KEY>"  | pnpm exec wrangler secret put ENCRYPTION_KEY

cd ../..
```

The portal needs `ENCRYPTION_KEY` but not `MCP_SHARED_TOKEN` (it has no `/mcp` endpoint to gate).

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

## Updating an existing deployment

After pulling changes, redeploy the servers that changed:

```bash
cd servers/<name>   # or apps/portal
pnpm exec wrangler types && pnpm exec wrangler deploy
```

Bindings and secrets persist across deploys — you only need to redo steps 2-4 once, at initial setup.
