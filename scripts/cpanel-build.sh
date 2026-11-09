#!/usr/bin/env bash
# Build + migrate + restart LiveSell on cPanel, from the repo cloned by cPanel "Git Version Control".
# Run in cPanel Terminal from the repo root, with Node 22 active (see docs/DEPLOY-CPANEL.md):
#   bash scripts/cpanel-build.sh
# Settings (optional):
#   API_URL      public API address baked into the web app (default https://api.sell.innovative.ng)
#   ENV_FILE     file with DATABASE_URL for migrations (default ~/.livesell-migrate.env; mode 600, outside the repo)
#   SKIP_WEB=1   API only (e.g. if the web build runs out of memory on shared hosting)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
API_URL="${API_URL:-https://api.sell.innovative.ng}"
ENV_FILE="${ENV_FILE:-$HOME/.livesell-migrate.env}"

major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || { echo "Node $(node -v) is too old; activate Node 22 first (see docs/DEPLOY-CPANEL.md)"; exit 1; }

echo "== Installing dependencies (API + web)"
npm ci --include=dev --no-audit --no-fund

echo "== Building the API"
( cd apps/api && npx prisma generate && npx nest build )

echo "== Database migrations"
if [ -f "$ENV_FILE" ]; then
  # Only DATABASE_URL is needed; the file is never printed.
  ( set -a; . "$ENV_FILE"; set +a; cd apps/api && npx prisma migrate deploy && { [ "${SEED:-0}" = 1 ] && npm run seed || true; } )
else
  echo "   skipped: $ENV_FILE not found (create it with DATABASE_URL=... to migrate from here)"
fi

if [ "${SKIP_WEB:-0}" != 1 ]; then
  echo "== Building the web app (API: $API_URL)"
  ( cd apps/web && NEXT_PUBLIC_API_URL="$API_URL" NEXT_TELEMETRY_DISABLED=1 NEXT_DIST_DIR=.next-cpanel npx next build )
  SA="apps/web/.next-cpanel/standalone/apps/web"
  rm -rf "$SA/.next-cpanel/static" "$SA/public"
  cp -r apps/web/.next-cpanel/static "$SA/.next-cpanel/static"
  [ -d apps/web/public ] && cp -r apps/web/public "$SA/public"
  rm -f "$SA/.env" "$SA/.env.local" "$SA/.env.production"
fi

echo "== Restarting (Passenger)"
for app in apps/api "apps/web/.next-cpanel/standalone/apps/web"; do
  [ -d "$app" ] && mkdir -p "$app/tmp" && touch "$app/tmp/restart.txt"
done
echo "Done. Check https://${API_URL#https://}/health/ready"
