# Deploying on cPanel (build on your PC, upload zips)

Target: web at **https://sell.innovative.ng**, API at **https://api.sell.innovative.ng**, both as cPanel Node.js apps
(Phusion Passenger). The hosting account's memory limit (CloudLinux LVE) kills `nest build` and `next build`, so:
- the apps are **built on your PC** and uploaded as zips;
- the server only runs them, plus migrations from the Git checkout (light on memory).

## What cPanel doesn't provide

| Need | Use |
|---|---|
| **Node 22+** | "Setup Node.js App" (24 is fine) |
| **PostgreSQL 13+** | A managed database (Neon or Supabase, EU region) or the host's PostgreSQL |
| **Redis** (BullMQ jobs, rate limits) | Redis Cloud (free 30 MB to start) or the host's Redis |
| **Object storage** | The AWS S3 bucket (or Cloudflare R2), not MinIO/localhost |

## 1. Subdomains and SSL

1. cPanel → Domains: create `sell.innovative.ng` and `api.sell.innovative.ng`.
2. cPanel → SSL/TLS Status: run AutoSSL so both have certificates.

## 2. Build the zips (on your PC)

From the repo root in PowerShell:

```powershell
git pull
node scripts/package-cpanel.mjs --api-url https://api.sell.innovative.ng
```

This creates `deploy\cpanel\livesell-api.zip` and `deploy\cpanel\livesell-web.zip` (git-ignored, no secrets). The API
URL is built into the web app.

## 3. Upload and extract

In cPanel → File Manager:
1. Create the folders `livesell-api` and `livesell-web` in your home directory.
2. Upload each zip into its folder, then right-click → **Extract**.

After extracting you should have:
- `~/livesell-api/dist/main.js` and `~/livesell-api/package.json`;
- `~/livesell-web/apps/web/server.js` and `~/livesell-web/node_modules`.

## 4. Node.js apps

cPanel → **Setup Node.js App**. If you created apps earlier with other roots, delete them or edit their root. Create one
per row:

| Field | API | Web |
|---|---|---|
| Node.js version | 22+ | same |
| Application mode | Production | Production |
| Application root | `livesell-api` | `livesell-web/apps/web` |
| Application URL | `api.sell.innovative.ng` | `sell.innovative.ng` |
| Startup file | `dist/main.js` | `server.js` |
| Environment variables | the table below | none |

**API:**
1. After creating it, click **Run NPM Install**. It installs runtime dependencies only, using the bundled lockfile; it
   is slow but light on memory.
2. Click Restart.

**Web:** don't run NPM Install. Its dependencies are in `livesell-web/node_modules`, one level above the app root, which
keeps the cPanel Node.js selector happy.

**Application mode "Production" sets `NODE_ENV=production`, which refuses test payment keys.** For staging with test
keys, add `NODE_ENV` = `staging`. If the log still says "test key in production", leave the payment keys out until you
have live ones.

**API environment variables.** Never put these in git:

| Variable | Value |
|---|---|
| `APP_URL` | `https://sell.innovative.ng` |
| `API_PUBLIC_URL` | `https://api.sell.innovative.ng` |
| `CORS_ORIGINS` | `https://sell.innovative.ng` |
| `COOKIE_SECURE` | `true` |
| `DATABASE_URL` | Postgres URL (`?sslmode=require` for managed databases) |
| `REDIS_URL` | `rediss://…` |
| `JWT_ACCESS_SECRET`, `TOKEN_HASH_SECRET` | each its own (see below) |
| `DATA_ENCRYPTION_KEY` | see below; **back it up**, losing it loses sellers' gateway keys |
| `S3_*` | bucket, region, keys (as in `.env.example`) |
| `PAYSTACK_*`, `FLUTTERWAVE_*`, `BACHS_*` | **rotated** keys |
| `VELTRIX_*` | when messaging is ready |
| `JOBS_ENABLED` | `true` |
| `PUSH_ENABLED` | `true` |
| `ALERT_WEBHOOK_URL` | optional |

Generate the secrets and paste each value:

```bash
node -e "const c=require('crypto');console.log('JWT_ACCESS_SECRET='+c.randomBytes(48).toString('base64'));console.log('TOKEN_HASH_SECRET='+c.randomBytes(48).toString('base64'));console.log('DATA_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'))"
```

## 5. Migrations (cPanel Terminal)

This uses the Git checkout at `~/repositories/livesell-africa` (Git Version Control) and `~/.livesell-migrate.env`,
which holds `DATABASE_URL`, mode 600. Activate Node first: copy the `source …/bin/activate` command shown on any
Node.js app's page.

```bash
cd ~/repositories/livesell-africa && git pull
SEED=1 bash scripts/cpanel-migrate.sh     # SEED=1 only the first time
```

Then, in Setup Node.js App, restart the API and check `https://api.sell.innovative.ng/health/ready` (should say `ok`).
- If the API won't start, the reason is in `~/livesell-api/stderr.log`. The startup check lists every bad setting at
  once.
- If Postgres (5432) or Redis (6379) can't be reached, the host may block those outgoing ports. Ask them to open them,
  or use their own PostgreSQL/Redis.

## 6. Keep the API awake (background jobs)

Passenger stops an idle app. While it's stopped, no jobs run: stock-hold expiry, payment reconciliation, reminders,
push receipts. Add a cPanel **Cron Job** every 5 minutes:

```
*/5 * * * * curl -fsS https://api.sell.innovative.ng/health > /dev/null 2>&1
```

## 7. After it's up

- **First platform admin:** register on the site, then in the database run:
  ```sql
  UPDATE users SET platform_role = 'PLATFORM_ADMIN' WHERE email = '…';
  ```
- **Payment webhooks:** `https://api.sell.innovative.ng/api/v1/payments/<provider>/webhook`. Register them, then set
  `*_WEBHOOKS_ENABLED=true`.
- **Mobile app:** the `preview` profile in `apps/mobile/eas.json` already points at `https://api.sell.innovative.ng`.

## Every release

1. **Build** on your PC (step 2).
2. **Migrate** on the server (step 5, without `SEED=1`).
3. **API:** delete `~/livesell-api/dist`, then upload and extract the new zip. Run NPM Install only if
   `package-lock.json` changed. Restart.
4. **Web:** delete everything inside `~/livesell-web`, then upload and extract the new zip, and restart.
