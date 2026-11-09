#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into an EMPTY database, then print row counts of the key tables.
#
#   TARGET_DATABASE_URL=postgresql://user:pass@host:5432/livesell_restore ./scripts/restore.sh backups/livesell-….dump
#
# Never point this at the live database: restore into a new one, check it, then switch the app's DATABASE_URL.
# Run a restore drill monthly (docs/DEPLOYMENT.md) — a backup that was never restored is not a backup.
set -euo pipefail

FILE="${1:?usage: restore.sh <file.dump>}"
: "${TARGET_DATABASE_URL:?set TARGET_DATABASE_URL (an empty database)}"
URL="${TARGET_DATABASE_URL%%\?*}"

TABLES="$(psql "$URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
if [ "$TABLES" != "0" ]; then
  echo "refusing: the target database is not empty ($TABLES tables)" >&2
  exit 1
fi

pg_restore --no-owner --no-privileges --exit-on-error --dbname="$URL" "$FILE"
psql "$URL" -At -F ' ' -c "
  SELECT 'tenants', count(*) FROM tenants UNION ALL
  SELECT 'orders', count(*) FROM orders UNION ALL
  SELECT 'payment_transactions', count(*) FROM payment_transactions UNION ALL
  SELECT 'ledger_entries', count(*) FROM ledger_entries UNION ALL
  SELECT '_prisma_migrations', count(*) FROM _prisma_migrations"
# The ledger must still balance after a restore.
psql "$URL" -Atc "SELECT CASE WHEN COALESCE(SUM(CASE WHEN direction::text='DEBIT' THEN amount_minor ELSE -amount_minor END),0)=0 THEN 'ledger balanced' ELSE 'LEDGER UNBALANCED' END FROM ledger_entries"
echo "restore ok"
