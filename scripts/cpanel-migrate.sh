#!/usr/bin/env bash
# Database migrations (and optional seed) on cPanel, from the repo checkout cloned by Git Version Control.
# Light on memory: no compiling. The apps themselves are built on a PC (scripts/package-cpanel.mjs) and uploaded.
#   cd ~/repositories/livesell-africa && git pull && bash scripts/cpanel-migrate.sh        # SEED=1 the first time
# Needs ~/.livesell-migrate.env (mode 600) with DATABASE_URL=..., and node_modules from an earlier install
# (FORCE_INSTALL=1 to install; that is slow on shared hosting but uses little memory).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
ENV_FILE="${ENV_FILE:-$HOME/.livesell-migrate.env}"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (DATABASE_URL=...)"; exit 1; }

# CloudLinux's nodevenv `npm` forces --prefix into the virtualenv; use the real npm CLI.
unset NPM_CONFIG_PREFIX npm_config_prefix
NPM_CLI="$(dirname "$(node -p 'process.execPath')")/../lib/node_modules/npm/bin/npm-cli.js"
[ -f "$NPM_CLI" ] || NPM_CLI="$(command -v npm)"
BIN="$ROOT/node_modules/.bin"
if [ "${FORCE_INSTALL:-0}" = 1 ] || [ ! -x "$BIN/prisma" ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "== Installing dependencies"
  node "$NPM_CLI" --prefix "$ROOT" ci --include=dev --no-audit --no-fund
fi

set -a; . "$ENV_FILE"; set +a   # never printed
cd apps/api
echo "== Migrations"
"$BIN/prisma" migrate deploy
if [ "${SEED:-0}" = 1 ]; then
  echo "== Seed (plans, permissions, settings; idempotent)"
  "$BIN/prisma" generate   # the seed uses the generated client; schema may have changed since the last pull
  "$BIN/ts-node" --transpile-only prisma/seed.ts
fi
echo "Done."
