#!/usr/bin/env bash
set -euo pipefail

# Deploys one server/portal package. wrangler.jsonc commits a "yourdomain.com" placeholder in its
# custom-domain route (see docs/SETUP.md) so the operator's real domain never touches the repo;
# this script substitutes the real value from the DEPLOY_DOMAIN env var into a gitignored, generated
# copy of that config before calling `wrangler deploy`, so the placeholder is the only thing committed.
#
# Usage: scripts/deploy.sh <package-dir>   e.g. scripts/deploy.sh servers/nz-govt-mcp

pkg_dir="$1"
: "${DEPLOY_DOMAIN:?DEPLOY_DOMAIN env var is required}"

generated_config="${pkg_dir}/.wrangler-deploy.generated.jsonc"
trap 'rm -f "$generated_config"' EXIT

sed "s/yourdomain\.com/${DEPLOY_DOMAIN}/g" "${pkg_dir}/wrangler.jsonc" > "$generated_config"

(cd "$pkg_dir" && pnpm exec wrangler deploy --config .wrangler-deploy.generated.jsonc)
