# Deploying LiveSell Africa

## Quick start: one VPS (Hostinger KVM 2 or similar, Ubuntu 24.04)

1. **DNS:** point two A records at the server's IP: `sell.innovative.ng` and `api.sell.innovative.ng`.
2. **Set up the server.** As root, run:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Innovatyou/livesell-africa/main/scripts/server-setup.sh -o setup.sh && bash setup.sh
   ```
   It asks for:
   - your domains;
   - staging or production;
   - your S3 bucket and keys;
   - an email for the certificate.

   Then it:
   - installs Docker and enables the firewall (22/80/443) and swap;
   - generates every secret into root-only files (`.env.deploy`, `apps/api/.env.production`);
   - gets a Let's Encrypt certificate (renewed automatically);
   - builds, migrates and seeds, then starts Postgres, Redis, the API, the web app and Nginx;
   - schedules a daily database backup.
3. **First admin:** register on the web, then run the `UPDATE users …` command the script prints.
4. **Every release:**
   ```bash
   bash /srv/livesell/scripts/release.sh
   ```
   It pulls, builds, backs up, migrates, restarts, health-checks, and prints a rollback command if anything fails.

The rest of this guide covers managed Postgres/Redis, monitoring and the go-live checklist.

## Environments

Use three environments, each with its own database, Redis, bucket, keys and domains:

| | Development | Staging | Production |
|---|---|---|---|
| Stack | `docker-compose.yml` (Postgres, Redis, MinIO) + `npm run start:dev` / `next dev` | `docker-compose.prod.yml` (`selfhosted` profile allowed) | `docker-compose.prod.yml`, with **managed** Postgres 16 (point-in-time recovery on) and managed Redis |
| Payment keys | test | test / sandbox | **live** (the API refuses test keys) |
| Veltrix | off, or local | test account | production account |
| `NODE_ENV` | development | staging | production |

**Settings the API refuses in staging and production** (`src/config/production-checks.ts`). It won't start with:
- non-https `APP_URL` or `API_PUBLIC_URL`;
- `COOKIE_SECURE` other than true;
- `*`, localhost or http values in `CORS_ORIGINS`;
- localhost database or S3;
- placeholder or identical JWT / token-hash secrets;
- in production only: test payment keys.

## Secrets

- Put all secrets in `apps/api/.env.production` on the server (mode 600), or in the host's secret manager. **Never commit them.** `.gitignore` covers `.env.*` and `infra/tls/*.pem`.
- Generate each secret separately:

  | Secret | Command |
  |---|---|
  | `JWT_ACCESS_SECRET`, `TOKEN_HASH_SECRET` | `openssl rand -base64 48` (each its own) |
  | `DATA_ENCRYPTION_KEY` | `openssl rand -base64 32` |

- **`DATA_ENCRYPTION_KEY` encrypts sellers' gateway keys and tracking tokens.** Keep it in two safe places: losing it means sellers must re-enter their keys.
- **Rotate every key that was ever pasted into chat or email before launch.** That includes the Paystack, Flutterwave and Bachs test keys used during development.

## First deployment

1. **DNS:** point `app.` and `api.` to the server.
2. **TLS:** get certificates (for example `certbot certonly --webroot -w infra/nginx/acme -d app.… -d api.…`). Put `fullchain.pem` and `privkey.pem` in `infra/tls/`. The server names come from `APP_DOMAIN` / `API_DOMAIN` in `.env.deploy` (`infra/nginx/templates/default.conf.template`).
3. **API environment:** fill in `apps/api/.env.production` from `.env.example`.
4. **Build:**
   ```bash
   export PUBLIC_API_URL=https://api.livesell.africa RELEASE=$(date +%Y%m%d%H%M)
   docker compose -f docker-compose.prod.yml build
   ```
5. **Migrate and seed:**
   ```bash
   docker compose -f docker-compose.prod.yml run --rm migrate
   ```
   This applies migrations and the idempotent platform seed: plans, permissions, settings. Never run `seed:demo` outside development.
6. **Start:** `docker compose -f docker-compose.prod.yml up -d`, then check `https://api…/health/ready` (database + Redis).
7. **First platform admin:** register normally, then run in the database:
   ```sql
   UPDATE users SET platform_role = 'PLATFORM_ADMIN' WHERE email = '…';
   ```
8. **Platform admin setup:** in `/admin`, enable the payment providers, check plans, prices and settings, connect WhatsApp forwarding, and map the templates.
9. **Veltrix:**
   - deploy migrations 174–176;
   - set the platform WhatsApp number's Meta signature (WhatsApp servers → Webhook security);
   - set `VELTRIX_*` and restart the API.
10. **Provider webhooks:** register these URLs in the Paystack, Flutterwave and Bachs dashboards, then set the `*_WEBHOOKS_ENABLED` flags:
    ```
    https://api…/api/v1/payments/<provider>/webhook
    https://api…/api/v1/payments/<provider>/webhook/<accountId>
    ```

## Every release

```bash
git pull && export RELEASE=$(git rev-parse --short HEAD)
docker compose -f docker-compose.prod.yml build
./scripts/backup.sh /var/backups/livesell            # before every migration
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d      # recreates api/web with the new images
curl -fsS https://api…/health/ready
```

**Migrations:**
- They only ever add; an applied migration is never edited.
- To roll back, redeploy the previous `RELEASE` images.
- A migration is undone only by a new, forward migration (or a restore, if data was damaged).

**Scaling:** API instances can run side by side. The BullMQ schedulers are idempotent and every job is safe to run concurrently.

## Backups

- **Primary:** the managed database's point-in-time recovery (keep at least 7 days).
- **Independent copy:** `scripts/backup.sh` from cron, daily:
  ```
  15 2 * * * cd /srv/livesell && DATABASE_URL=… BACKUP_S3_URI=s3://… ./scripts/backup.sh /var/backups/livesell
  ```
  - It verifies each archive, keeps 14 days locally, and copies off-site.
  - Use a bucket in a different account or region from the media bucket.
- **Monthly restore drill:**
  ```
  TARGET_DATABASE_URL=…/livesell_restore ./scripts/restore.sh <file>
  ```
  - It refuses a non-empty target, prints row counts, and checks the ledger still balances.
  - It was rehearsed locally on 2026-11-08.
- **Media (S3/R2):** turn on bucket versioning. Only object keys are in the database.

> cPanel hosting (sell.innovative.ng): see `DEPLOY-CPANEL.md`.

## Mobile app (seller)

1. **Link the project:** in `apps/mobile`, run `npx eas-cli@latest init`. This creates the Expo project and writes `extra.eas.projectId` (or set `EAS_PROJECT_ID` as an EAS environment variable).
2. **Android push (FCM v1):**
   - Upload `google-services.json` as an EAS **file** environment variable named `GOOGLE_SERVICES_JSON`. Never commit it; it's git-ignored.
   - In Firebase → Project settings → Service accounts, generate a private key.
   - Upload it with `eas credentials` → Android → production → Google Service Account → FCM V1.
3. **iOS push:** `eas build -p ios` asks to create the APNs key (needs a paid Apple Developer account), or use `eas credentials`.
4. **API:** set `PUSH_ENABLED=true` (and `EXPO_ACCESS_TOKEN` if enhanced push security is on). Delivery receipts are checked every 15 minutes, and uninstalled phones are switched off automatically.
5. **Builds:**
   - `eas build --profile preview` for internal testers (staging API);
   - `eas build --profile production` + `eas submit` for the stores.

   Push notifications don't work in Expo Go on Android; use a development or preview build.

## Monitoring

**Logs:**
- Staging and production log one JSON object per line; collect them with the host's agent (Docker `json-file` logs, rotated).
- Every response carries `X-Request-Id`. Nginx passes the client's ID through, or makes one.
- Server errors are logged once, with the request ID, route, user and store — never request bodies or secrets.

**Alerts:**
- Set `ALERT_WEBHOOK_URL` (Slack or Teams) to get each distinct 5xx at most once per 5 minutes.
- Point an uptime monitor at `/health/ready`.

**Daily check:** `/admin` (Overview → Problems):
- failed or unsigned webhooks;
- failed messages;
- stuck order events;
- database and Redis status.

Also check the reconciliation issues in the payments admin.

**Load test before launch:** `tools/load/storefront.k6.js` against staging. The target is p95 under 500 ms for browsing and under 1.5 s for checkout, with no overselling (409 once sold out).

## Go-live checklist

- [ ] The code is in version control (git), and CI (`.github/workflows/ci.yml`) is green on the release commit.
- [ ] Every key used in development has been rotated, and the live payment keys are set.
- [ ] Payment webhook URLs are registered and `*_WEBHOOKS_ENABLED=true`. Signature verification was tested with each provider's "send test webhook".
- [ ] One real live payment of a small amount (each provider) is verified, refunded, and reconciled.
- [ ] Veltrix migrations 174–176 are deployed. The platform number is signature-protected, forwarding is connected, and the Meta templates are approved and mapped.
- [ ] Commission rate, invoice rules, messaging prices and limits, plan prices, and stock holds are confirmed in `/admin`.
- [ ] Legal: Terms and Privacy are reviewed, and NDPA registration / DPO is handled.
- [ ] Backups are scheduled, an off-site copy exists, and one restore drill has been done on staging.
- [ ] Uptime monitor and `ALERT_WEBHOOK_URL` are set.
- [ ] The staging load test has passed.
- [ ] An external penetration test was done, or is scheduled within the first month.
