# Deploying on cPanel (Git Version Control + Terminal)

Target: web at **https://sell.innovative.ng**, API at **https://api.sell.innovative.ng**, both as cPanel Node.js apps
(Phusion Passenger), built on the server from the GitHub repo. This is a lighter alternative to the Docker setup in
`DEPLOYMENT.md`.

## What cPanel doesn't provide

| Need | Use |
|---|---|
| **Node 22+** | Pick 22 (or higher) in "Setup Node.js App". If the host only offers older versions, ask them to add 22 |
| **PostgreSQL 13+ (16 preferred)** | A managed database, e.g. Neon or Supabase (EU region, closest to Nigeria), or the host's PostgreSQL if 13+ |
| **Redis** (BullMQ jobs, rate limits) | Redis Cloud (free 30 MB plan to start), or the host's Redis. Avoid per-command-billed Redis: BullMQ is chatty |
| **Object storage** | The AWS S3 bucket (or Cloudflare R2). Not MinIO/localhost; the API refuses it |

Shared hosts sometimes block outgoing connections to ports like 5432 (Postgres) and 6379 (Redis). Step 3 checks this.

## 1. Subdomains and SSL

1. cPanel → Domains: create `sell.innovative.ng` and `api.sell.innovative.ng`.
2. cPanel → SSL/TLS Status: run AutoSSL so both have certificates.

## 2. Clone the repo

cPanel → **Git Version Control** → Create:
- Clone URL: `https://github.com/Innovatyou/livesell-africa.git`
- Repository path: `repositories/livesell-africa`
- Name: `livesell-africa`

The repo is public, so no key is needed. If you make it private, add cPanel's SSH key (SSH Access → Manage keys) to
GitHub → repo → Settings → Deploy keys, read-only, and clone `git@github.com:Innovatyou/livesell-africa.git`.

## 3. Create the two Node.js apps

cPanel → **Setup Node.js App** → Create, once per app:

| Field | API | Web |
|---|---|---|
| Node.js version | 22+ | same |
| Application mode | Production | Production |
| Application root | `repositories/livesell-africa/apps/api` | `repositories/livesell-africa/apps/web/.next-cpanel/standalone/apps/web` |
| Application URL | `api.sell.innovative.ng` | `sell.innovative.ng` |
| Startup file | `dist/main.js` | `server.js` |
| Environment variables | the table below | none |

Don't click "Run NPM Install" for either app; the build script installs everything. The web app's folder only exists
after the first build. If cPanel refuses to create the app before then, create the web app after step 5.

**Application mode "Production" sets `NODE_ENV=production`, which refuses test payment keys.** For staging with test
keys, add a variable `NODE_ENV` = `staging`. If the log still says "test key in production", leave the payment keys out
until you have live ones.

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

Generate the secrets in the Terminal (or on your PC) and paste each value:

```bash
node -e "const c=require('crypto');console.log('JWT_ACCESS_SECRET='+c.randomBytes(48).toString('base64'));console.log('TOKEN_HASH_SECRET='+c.randomBytes(48).toString('base64'));console.log('DATA_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'))"
```

## 4. Terminal: Node 22 and the connection check

Open cPanel → **Terminal**. At the top of the API app's page, "Setup Node.js App" shows the command that enters its
environment. Copy and run it; it looks like:

```bash
source ~/nodevenv/repositories/livesell-africa/apps/api/22/bin/activate && cd ~/repositories/livesell-africa/apps/api
cd ~/repositories/livesell-africa
node -v    # must be v22 or higher
```

Store the database URL for migrations in a private file outside the repo. The `read` command doesn't echo, so the URL
doesn't end up in your shell history:

```bash
read -rsp 'DATABASE_URL: ' u && printf 'DATABASE_URL=%s\n' "$u" > ~/.livesell-migrate.env && chmod 600 ~/.livesell-migrate.env && unset u; echo
```

Check that the server can reach the database and Redis. Use your hosts and ports:

```bash
node -e "const n=require('net');for(const [h,p] of [['DB_HOST',5432],['REDIS_HOST',6379]]){const s=n.connect(p,h,()=>{console.log('ok',h,p);s.end()});s.on('error',e=>console.log('BLOCKED',h,p,e.code));s.setTimeout(5000,()=>{console.log('TIMEOUT',h,p);s.destroy()})}"
```

If either is blocked, ask the host to open the port. Or use the host's own PostgreSQL/Redis.

## 5. Build, migrate, start

```bash
SEED=1 bash scripts/cpanel-build.sh      # first time only: SEED=1 loads plans, permissions, settings
```

The script:
- installs dependencies;
- builds the API;
- runs `prisma migrate deploy` with `~/.livesell-migrate.env`;
- builds the web app with `https://api.sell.innovative.ng` built in;
- restarts both apps.

Then open `https://api.sell.innovative.ng/health/ready` (should say `ok`) and https://sell.innovative.ng.

- If the API won't start, the reason is in `repositories/livesell-africa/apps/api/stderr.log`. The startup check lists
  every bad setting at once.
- If the **web build is killed** (shared hosting memory limits), run `SKIP_WEB=1 bash scripts/cpanel-build.sh`. Then
  build the web app on your PC (`node scripts/package-cpanel.mjs`), upload `deploy/cpanel/livesell-web.zip`, and extract
  it into a separate web app root.

## 6. Keep the API awake (background jobs)

Passenger stops an app after it has been idle for a while. While it's stopped, no jobs run: stock-hold expiry, payment
reconciliation, reminders, push receipts. Add a cPanel **Cron Job** every 5 minutes:

```
*/5 * * * * curl -fsS https://api.sell.innovative.ng/health > /dev/null 2>&1
```

Shared hosting can still restart apps under memory/CPU limits. Watch `/admin` → Overview → Problems. If jobs fall
behind, move the API to a VPS (`DEPLOYMENT.md`); the web app can stay on cPanel.

## 7. After it's up

- **First platform admin:** register on the site, then in the database run:
  ```sql
  UPDATE users SET platform_role = 'PLATFORM_ADMIN' WHERE email = '…';
  ```
- **Payment webhooks:** `https://api.sell.innovative.ng/api/v1/payments/<provider>/webhook`. Register them, then set
  `*_WEBHOOKS_ENABLED=true`.
- **Mobile app:** the `preview` profile in `apps/mobile/eas.json` already points at `https://api.sell.innovative.ng`.

## Every release

1. Git Version Control → `livesell-africa` → Manage → Pull or Deploy → **Update from Remote**.
2. In the Terminal, with Node 22 active (step 4), from `~/repositories/livesell-africa` run:
   ```bash
   bash scripts/cpanel-build.sh
   ```
   It migrates before restarting.

**Alternative without a server build:** `node scripts/package-cpanel.mjs` on your PC creates upload zips in
`deploy/cpanel/`:
- API zip: startup `dist/main.js`, then click Run NPM Install;
- web zip: startup `apps/web/server.js`.
