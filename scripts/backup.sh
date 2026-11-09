#!/usr/bin/env bash
# Logical Postgres backup (MASTER-SPEC §27 backup procedures).
#
#   DATABASE_URL=postgresql://user:pass@host:5432/livesell ./scripts/backup.sh [backup_dir]
#
# - pg_dump custom format (compressed, restorable table by table), one file per run: livesell-YYYYmmdd-HHMMSS.dump
# - verifies the archive is readable (pg_restore --list) before calling it good
# - keeps the newest $KEEP_DAYS days locally (default 14)
# - optional off-site copy: set BACKUP_S3_URI=s3://bucket/path (needs the aws CLI; works with R2 via AWS_ENDPOINT_URL)
# Managed Postgres (point-in-time recovery) is the primary safety net; this is the independent, portable copy.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
DIR="${1:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
FILE="$DIR/livesell-$STAMP.dump"
URL="${DATABASE_URL%%\?*}"   # pg_dump doesn't understand Prisma's ?schema= parameter

mkdir -p "$DIR"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$FILE" "$URL"
pg_restore --list "$FILE" > /dev/null   # fails loudly if the archive is unusable
SIZE="$(du -h "$FILE" | cut -f1)"
echo "backup ok: $FILE ($SIZE)"

if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp "$FILE" "${BACKUP_S3_URI%/}/$(basename "$FILE")" --only-show-errors
  echo "copied to ${BACKUP_S3_URI%/}/$(basename "$FILE")"
fi

find "$DIR" -name 'livesell-*.dump' -type f -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/pruned: /' || true
