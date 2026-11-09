# LiveSell Africa

The operating system for social commerce & live selling. Built for Nigeria first.

**Status: Phases 1–12 complete; seller mobile app (`apps/mobile`, React Native) built, awaiting sign-off — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** — delivery zones, pickup and dispatch tracking,
sales and live-selling analytics with CSV/PDF reports, on top of automatic WhatsApp/SMS/email order updates and ordering
by product code on the platform WhatsApp number, Veltrix messaging with usage tracking and limits, automated CAC checks, bank transfers and reconciliation, online
payments (Paystack, Flutterwave, Bachs), a double-entry ledger, orders, live selling, storefront, products, inventory,
customers, onboarding, subscriptions and the seller dashboard.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the phase reports in [`docs/`](docs/).

## Run locally

Requires Node 22+, Docker.

```bash
npm install
docker compose up -d postgres redis minio minio-init   # MinIO console: http://localhost:9001

cp .env.example apps/api/.env
# fill the three secrets:
#   JWT_ACCESS_SECRET   → openssl rand -base64 48
#   DATA_ENCRYPTION_KEY → openssl rand -base64 32
#   TOKEN_HASH_SECRET   → openssl rand -base64 48

cd apps/api
npx prisma generate
npx prisma migrate deploy
npm run seed            # permissions, plans (₦5k/₦12k/₦25k/custom), providers (disabled)
npm run start:dev       # http://localhost:4000  ·  docs: /api/docs
npm run seed:demo       # optional, dev only: demo@livesell.local / DemoSeller2026

# web (second terminal)
cp apps/web/.env.example apps/web/.env.local
npm run web:dev         # http://localhost:3000
```

## Test

```bash
cd apps/api
npm test                # unit
npm run test:e2e        # needs Postgres (livesell_test DB) + Redis + MinIO; rebuilds the test DB from migrations
cd ../web && npm test   # frontend unit tests (Vitest)
```

## Full stack in Docker

```bash
docker compose up --build    # API behind Nginx on http://localhost:8080
docker compose exec api npx prisma migrate deploy
```

## API

| Method | Path | Auth |
|---|---|---|
| POST | `/api/v1/auth/register` | public |
| POST | `/api/v1/auth/login` | public |
| POST | `/api/v1/auth/refresh` | refresh cookie |
| POST | `/api/v1/auth/logout` · `logout-all` | cookie / bearer |
| GET | `/api/v1/auth/me` | bearer |
| POST | `/api/v1/auth/verify-email` · `verify-email/resend` | public / bearer |
| POST | `/api/v1/auth/forgot-password` · `reset-password` | public |
| GET | `/api/v1/workspace` | bearer + `X-Tenant-Id` |
| GET | `/api/v1/workspace/members` | `staff:manage` |
| GET | `/api/v1/workspace/audit-logs` | `audit:read` |
| GET | `/health/live` · `/health/ready` | public |
| POST | `/api/v1/auth/phone/send-otp` · `phone/verify` | bearer |
| GET | `/api/v1/plans` | public |
| GET · POST · PATCH | `/api/v1/admin/plans` | platform admin |
| GET | `/api/v1/onboarding` | tenant member |
| GET · PATCH | `/api/v1/store/profile` | member / `store:manage` |
| POST · PUT · DELETE | `/api/v1/store/logo/upload-url` · `store/logo` | `store:manage` |
| GET · POST | `/api/v1/business-verification` (+ `/upload-url`) | `store:manage` |
| GET · POST | `/api/v1/admin/business-verifications` (+ `/:id/approve` · `/reject`) | platform admin / support |
| GET · POST · DELETE | `/api/v1/staff/invitations` (+ `/:id/resend`) | `staff:manage` |
| PATCH | `/api/v1/staff/members/:id` | `staff:manage` |
| POST | `/api/v1/invitations/lookup` · `accept` · `accept-new` | public / bearer |
| GET | `/api/v1/billing/subscription` · `invoices` · `history` | `billing:manage` |
| POST | `/api/v1/billing/subscription/change` · `cancel` · `resume` · `cancel-pending-change` | `billing:manage` |
| POST | `/api/v1/billing/invoices/:id/pay` | `billing:manage` (Paystack link via the platform account) |
| GET | `/api/v1/dashboard/summary` · `dashboard/sales?period=` | `reports:read` |
| POST | `/api/v1/sales-inquiries` | public (5/hour/IP) |
| GET · PATCH | `/api/v1/admin/sales-inquiries` | platform admin / support |
| GET · POST · PATCH · DELETE | `/api/v1/products` (+ `/:id`, `/bulk`, `/import`, `/export`, `/by-code/:code`, `/code-suggestion`, `/media/upload-url`) | `products:read` / `products:write` |
| GET · POST · PATCH · DELETE | `/api/v1/categories` | `products:read` / `products:write` |
| POST | `/api/v1/inventory/variants/:variantId/adjust` | `inventory:write` |
| GET | `/api/v1/inventory/movements` · `low-stock` | `inventory:read` |
| GET · POST · PATCH · DELETE | `/api/v1/customers` (+ `/:id`, `/:id/anonymise`, `/:id/addresses`, `/tags`) | `customers:read` / `customers:write` |
| GET | `/api/v1/customers/export` | `customers:export` (audited) |
| GET · PATCH · POST · PUT · DELETE | `/api/v1/storefront` (+ `/publish`, `/unpublish`, `/cover`) | member / `store:manage` |
| GET | `/api/v1/store/:slug` (+ `/products`, `/products/:productSlug`, `/code/:code`) | public |
| POST | `/api/v1/store/:slug/checkout` | public (10/hour/IP) |
| GET | `/api/v1/store/:slug/orders/:reference?token=` | public, private token |
| GET · POST · PATCH | `/api/v1/orders` (+ `/:id`, `/:id/status`, `/:id/extend-hold`) | `orders:*` (per step) |
| GET | `/api/v1/orders/export` | `orders:read` + `customers:export` (audited) |
| GET · POST · PATCH | `/api/v1/live-sessions` (+ `/:id`, `/:id/start`, `/:id/end`, `/:id/cancel`, `/:id/report`) | `live:read` / `live:manage` |
| GET · POST · PATCH | `/api/v1/sales-channels` | `orders:read` / `live:manage` |
| POST | `/api/v1/orders/:id/payment-link` | `orders:create` |
| POST | `/api/v1/orders/:id/payments/verify` | `orders:read` |
| POST | `/api/v1/orders/:id/refunds` (`Idempotency-Key` header) | `payments:refund` |
| GET | `/api/v1/payments/transactions` · `payments/settings` | `payments:read` |
| PUT · POST · GET | `/api/v1/payments/settings/:provider/direct` · `/split` · `/active` · `/default`, `/payments/banks?provider=` (`:provider` = paystack · flutterwave · bachs) | `payments:configure` |
| POST | `/api/v1/store/:slug/orders/:reference/pay` | public, private token |
| POST | `/api/v1/payments/verify` | public (after the Paystack redirect) |
| POST | `/api/v1/payments/:provider/webhook` (+ `/:accountId`) | public, signature-checked (Paystack off until `PAYSTACK_WEBHOOKS_ENABLED=true`) |
| GET · PATCH | `/api/v1/admin/payment-providers` (+ `/:code`) | platform admin |
| GET · POST · PATCH · DELETE | `/api/v1/payments/bank-accounts` (+ `/:id`) | `payments:read` / `payments:configure` |
| GET | `/api/v1/payments/transfers/pending` · `/payments/reconciliation` | `payments:read` |
| POST | `/api/v1/orders/:id/transfers` (+ `/receipt-url`) | `orders:create` |
| POST | `/api/v1/orders/:id/transfers/:txnId/verify` · `/reject` | `payments:verify_transfer` |
| GET | `/api/v1/orders/:id/transfers/:txnId/receipt` | `payments:read` |
| POST | `/api/v1/store/:slug/orders/:reference/transfer` (+ `/receipt-url`) | public, private token |
| GET | `/api/v1/admin/payments/reconciliation` | platform admin / support |
| GET | `/api/v1/messaging/usage` · `/messaging/notifications` | `reports:read` |
| GET · POST | `/api/v1/admin/integrations/veltrix` (+ `/test`) | platform admin / support (test: admin) |
| GET · PUT | `/api/v1/admin/messaging/settings` | platform admin / support (PUT: admin) |
| GET · POST | `/api/v1/admin/messaging/usage` · `/admin/messaging/notifications` (+ `/:id/retry`) | platform admin / support (retry: admin) |
| POST | `/api/v1/admin/business-verifications/:id/registry-check` | platform admin / support |
