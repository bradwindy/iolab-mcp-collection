#!/usr/bin/env bash
# Validate renovate.json with Renovate 44.222.0.
# That release requires Node ^24.11 and pnpm ^11. The repository CI stays on
# Node 22 for the Workers suite, so this step uses an isolated Node 24 toolchain
# and does not change the Node version used by later steps.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
node_version="24.11.0"
renovate_version="44.222.0"
toolchain="$(mktemp -d)"
trap 'rm -rf "$toolchain"' EXIT

curl --fail --silent --show-error --location \
  "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz" |
  tar -xJ -C "$toolchain" --strip-components=1

export PATH="${toolchain}/bin:${PATH}"
hash -r
npm install --global pnpm@11
cd "$toolchain"
# pnpm dlx <pkg> runs that package's default bin. The validator is a second bin,
# so it has to be selected with --package.
pnpm dlx --package "renovate@${renovate_version}" \
  renovate-config-validator --strict --no-global "${root}/renovate.json"
