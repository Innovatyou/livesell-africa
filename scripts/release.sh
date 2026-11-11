#!/usr/bin/env bash
# Deploy the latest code on a server set up with scripts/server-setup.sh:
#   bash /srv/livesell/scripts/release.sh
# Pulls, builds new images, backs up the database, applies migrations, restarts api/web, checks health.
# If the health check fails it says how to roll back to the previous images.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.deploy ] || { echo "Run scripts/server-setup.sh first."; exit 1; }
set -a; . ./.env.deploy; set +a
DC="docker compose --env-file .env.deploy -f docker-compose.prod.yml --profile selfhosted"
DCT="$DC --profile tools"   # the one-off migrate job lives in the tools profile

PREV=$(git rev-parse --short HEAD)
git pull --ff-only -q
export RELEASE=$(git rev-parse --short HEAD)
echo "== Release $PREV → $RELEASE"
[ "$PREV" = "$RELEASE" ] && echo "   (no new commits; rebuilding anyway)"

$DC build api web && $DCT build migrate
mkdir -p /var/backups/livesell
$DC exec -T postgres pg_dump -U livesell -Fc livesell > "/var/backups/livesell/pre-$RELEASE-$(date +%F-%H%M).dump"
echo "   backup saved"
$DCT run --rm migrate
$DC up -d api web nginx
for i in $(seq 1 30); do curl -fsS "https://$API_DOMAIN/health/ready" > /dev/null 2>&1 && break; sleep 3; done
if curl -fsS "https://$API_DOMAIN/health/ready" > /dev/null; then
  echo "   healthy: https://$API_DOMAIN and https://$APP_DOMAIN on $RELEASE"
  docker image prune -f > /dev/null
else
  echo "   API is not healthy. Logs: $DC logs api --tail 80"
  echo "   Roll back the code: git checkout $PREV && RELEASE=$PREV $DC up -d api web"
  exit 1
fi
