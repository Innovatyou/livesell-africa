# Deploying on cPanel ("Setup Node.js App")

Target: web at **https://sell.innovative.ng**, API at **https://api.sell.innovative.ng**, both as cPanel Node.js apps
(Phusion Passenger). This is a lighter alternative to the Docker setup in `DEPLOYMENT.md`. Start with `NODE_ENV=staging`
(test payment keys allowed). Switch to `production` only with live keys.

## What cPanel doesn't provide

| Need | Use |
|---|---|
| **Node 22+** | Pick 22 (or higher) in "Setup Node.js App". If the host only offers older versions, ask them to add 22 |
| **PostgreSQL 13+ (16 preferred)** | A managed database, e.g. Neon or Supabase (choose an EU region, closest to Nigeria). The cPanel PostgreSQL works only if it is 13+ and you can reach it to run migrations |
| **Redis** (BullMQ jobs, rate limits) | Redis Cloud (free 30 MB plan is enough to start), or the host's Redis if offered. Avoid per-command-billed Redis: BullMQ is chatty |
| **Object storage** | The AWS S3 bucket (or Cloudflare R2). Not MinIO/localhost; the API refuses it |

## 1. Build the bundles (on your PC)

```powershell
node scripts/package-cpanel.mjs --api-url https://api.sell.innovative.ng
```

Creates `deploy/cpanel/livesell-api.zip` and `deploy/cpanel/livesell-web.zip` (git-ignored, no secrets). The API URL is
built into the web app, so rebuild when it changes.

## 2. Subdomains and SSL

1. cPanel → Domains: create `sell.innovative.ng` and `api.sell.innovative.ng`.
2. cPanel → SSL/TLS Status: run AutoSSL so both have certificates.

## 3. Database, migrations, seed (from your PC)

Create the database, then from `apps/api` in PowerShell:

```powershell
$env:DATABASE_URL = "postgresql://USER:PASSWORD@HOST:5432/DB?sslmode=require"
npx prisma migrate deploy
npm run seed
Remove-Item Env:DATABASE_URL
```

Repeat `migrate deploy` for every release that adds migrations, **before** uploading the new API.

## 4. API app (api.sell.innovative.ng)

1. **Create the app.** In "Setup Node.js App" → Create:
   - Node 22;
   - mode **Production**;
   - application root `livesell-api`;
   - URL `api.sell.innovative.ng`;
   - startup file `dist/main.js`.
2. **Upload the code.** In File Manager, upload `livesell-api.zip` into `~/livesell-api` and extract it.
3. **Install.** Back in the app page, click **Run NPM Install**.
4. **Environment variables.** Add these in the app page. Never put them in git:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `staging` |
   | `APP_URL` | `https://sell.innovative.ng` |
   | `API_PUBLIC_URL` | `https://api.sell.innovative.ng` |
   | `CORS_ORIGINS` | `https://sell.innovative.ng` |
   | `COOKIE_SECURE` | `true` |
   | `DATABASE_URL` | managed Postgres URL (`sslmode=require`) |
   | `REDIS_URL` | `rediss://…` |
   | `JWT_ACCESS_SECRET`, `TOKEN_HASH_SECRET` | each its own (see below) |
   | `DATA_ENCRYPTION_KEY` | see below; **back it up**, losing it loses sellers' gateway keys |
   | `S3_*` | bucket, region, keys (as in `.env.example`) |
   | `PAYSTACK_*`, `FLUTTERWAVE_*`, `BACHS_*` | **rotated** test keys for staging |
   | `VELTRIX_*` | when messaging is ready |
   | `JOBS_ENABLED` | `true` |
   | `PUSH_ENABLED` | `true` |
   | `ALERT_WEBHOOK_URL` | optional |

   Generate the secrets on your PC:
   ```powershell
   node -e "const c=require('crypto');console.log('JWT_ACCESS_SECRET='+c.randomBytes(48).toString('base64'));console.log('TOKEN_HASH_SECRET='+c.randomBytes(48).toString('base64'));console.log('DATA_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'))"
   ```
5. **Start.** Click **Restart**, then open `https://api.sell.innovative.ng/health/ready`; it should return `ok`. If the app
   won't start, the reason is in `~/livesell-api/stderr.log`. The startup check lists every bad setting at once.

## 5. Web app (sell.innovative.ng)

1. **Create the app:**
   - Node 22, mode **Production**;
   - application root `livesell-web`;
   - URL `sell.innovative.ng`;
   - startup file `apps/web/server.js`.
2. **Upload the code.** Upload `livesell-web.zip` into `~/livesell-web` and extract it. **Don't run NPM Install**: the
   bundle already contains its trimmed `node_modules`.
3. **Start.** Click Restart and open https://sell.innovative.ng.

## 6. Keep the API awake (background jobs)

Passenger stops an app after it has been idle for a while. While it's stopped, no jobs run: stock-hold expiry, payment
reconciliation, reminders, push receipts. Add a cPanel **Cron Job** every 5 minutes:

```
*/5 * * * * curl -fsS https://api.sell.innovative.ng/health > /dev/null 2>&1
```

Even with this, shared hosting can restart apps under memory/CPU limits. Watch `/admin` → Overview → Problems. If jobs
fall behind, move the API to a VPS (`DEPLOYMENT.md`); the web app can stay on cPanel.

## 7. After it's up

- **First platform admin:** register on the site, then in the database run:
  ```sql
  UPDATE users SET platform_role = 'PLATFORM_ADMIN' WHERE email = '…';
  ```
- **Payment webhooks:** `https://api.sell.innovative.ng/api/v1/payments/<provider>/webhook`. Register them, then set
  `*_WEBHOOKS_ENABLED=true`.
- **Mobile app:** the `preview` profile in `apps/mobile/eas.json` already points at `https://api.sell.innovative.ng`.

## Every release

1. Pull the latest code.
2. Run `node scripts/package-cpanel.mjs --api-url https://api.sell.innovative.ng`.
3. Run `prisma migrate deploy` (step 3).
4. **API:** upload and extract the zip over `~/livesell-api`. Run NPM Install only if dependencies changed. Restart.
5. **Web:** delete `~/livesell-web/apps/web/.next-cpanel` (removes old build files), then upload, extract and restart.
