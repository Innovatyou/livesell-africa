# CLAUDE.md — LiveSell Africa

Read this file, `docs/MASTER-SPEC.md`, `docs/ARCHITECTURE.md` and `docs/PHASE-1.md` before any work.
`MASTER-SPEC.md` is the product brief and is the source of truth for scope.

## Status
- Phase 1 DONE: schema (45 tables), migrations, auth, multi-tenancy, RBAC, health, Docker, Nginx. 34 tests passing.
- Phase 2 BUILT, awaiting sign-off (see `docs/PHASE-2.md`): onboarding checklist, store profile, S3 presigned logo upload, phone OTP,
  business verification, staff invitations, admin-editable plans, trials/upgrades/downgrades/expiry/reminders (BullMQ), subscription
  guard (402 on writes when inactive), §7 dashboard API, `apps/web` (Next.js 16), commission-based vs subscription-based pricing
  (`pricing_model` on plans; `CommissionService.effectiveRate()` for Phase 5), versioned Terms/Privacy, Contact sales.
  API unit 29/29, web 11/11, e2e 58/58 (storage tests verified against a real AWS S3 bucket via `apps/api/test/.env.s3`,
  gitignored; without it the suite uses local MinIO).
- Phase 2 signed off. Phase 3 BUILT, awaiting sign-off (see `docs/PHASE-3.md`): products/variants with product codes (BAG001),
  categories, media (S3), CSV import/export, bulk updates, inventory (`InventoryService`: row-locked adjust/reserve/release/commitSale,
  append-only movements with balances), public storefront API + `/store/[slug]` pages with WhatsApp cart ordering, CRM (stats,
  segments, audited export, NDPA erasure). API unit 36/36, e2e 83/83, web 14/14.
- Phase 3 signed off. Phase 4 BUILT, awaiting sign-off (see `docs/PHASE-4.md`): orders (status machine in `src/orders/order-rules.ts`,
  product-code entry, stock reserve/release/commit, expiry job, history, export, invoice/receipt), live sessions + channels + report,
  storefront checkout + private tracking links. API unit 41/41, e2e 99/99, web 16/16.
- Phase 4 signed off. Phase 5 BUILT, awaiting sign-off (see `docs/PHASE-5.md`): `PaymentProvider` port + `PaystackAdapter`
  (fetch, sandbox-verified) behind `PaymentProviderRegistry`; `PaymentsService` (order links, storefront "Pay now", invoice
  payment via the platform key, verify/reconcile, refunds, webhooks behind `PAYSTACK_WEBHOOKS_ENABLED=false`); DIRECT
  (seller's encrypted key) and SPLIT (subaccount + flat `transaction_charge`) settlement; `LedgerService` journals; job
  every 10 min. API unit 56/56, e2e 127/127 (incl. 5 real Paystack sandbox calls), web 18/18.
- Phase 5 signed off. Phase 6 BUILT, awaiting sign-off (see `docs/PHASE-6.md`): `FlutterwaveAdapter` (v3 Standard, split via
  subaccount + flat charge) and `BachsAdapter` (REST, own-key only; Connect split blocked) behind the same port; provider
  `capabilities`; exact decimal conversion (`money-decimal.ts`); several providers per store with one default; per-provider
  webhooks; `provider_checkout_id`. API unit 74/74, e2e 148/148 (incl. 14 real sandbox calls: Paystack 5, Flutterwave 5,
  Bachs 4), web 19/19.
- Phase 6 signed off. Phase 7 BUILT, awaiting sign-off (see `docs/PHASE-7.md`): seller transfer accounts (`bank_accounts.for_transfers`),
  customer/staff transfer reports with private receipts, verification by `payments:verify_transfer` (exact amount, ledger
  `SELLER_BANK`, `markPaidTx` in one transaction), rejection, recorded refunds for transfers, `ReconciliationService` (seller,
  admin, daily job). API unit 75/75, e2e 159/159, web 20/20.
- Bank transfers become PAID only in `BankTransferService.verify()`; a report or receipt never marks anything paid.
- Phase 7 signed off. Phase 8 BUILT, awaiting sign-off (see `docs/PHASE-8.md`): `MessagingProvider`/`VerificationProvider` ports with
  Veltrix adapters (source-verified against `C:\laragon\www\mailwizz-yii3`), `NotificationService` (idempotent sends, retry/backoff,
  limits, usage pricing, delivery receipts), Veltrix `AuthMailer`/`BillingNotifier` (bound when `VELTRIX_ENABLED=true`), CAC registry
  check on business verification, admin integrations page, seller messaging page. Veltrix repo: additive Idempotency-Key + quick-send
  message ids (migration 174). API unit 91/91, e2e 171/171 (+4 live-Veltrix, opt-in), web 22/22.
- Phase 8 signed off. Phase 9 BUILT, awaiting sign-off (see `docs/PHASE-9.md`): transactional outbox (`outbox_events`, written in
  `OrdersService.history()` in the same tx) → `OrderNotifier` (WhatsApp free text in the 24 h window / approved template / SMS fallback,
  email invoice+receipt, store preferences, payment + abandoned-checkout reminders, manual reminder); `WhatsappCommerceService`
  (signed Veltrix forwarding to `POST /api/v1/whatsapp/webhook`, code → variant → qty → name → address → YES → real order, STATUS,
  STOP/START); admin template mapping + forwarding; encrypted tracking token for links. Veltrix repo: WhatsApp forwarding
  (migration 175). API unit 104/104, e2e 184/184, web 24/24.
- Phase 9 signed off. Phase 10 BUILT, awaiting sign-off (see `docs/PHASE-10.md`): delivery zones (city beats state, cheaper wins),
  pickup and out-of-zone policy (`storefront_settings.delivery_settings`), server-priced delivery at checkout and on WhatsApp
  (`DeliveryService.priceFor`), per-order delivery records + status machine (`src/logistics/delivery-rules.ts`) moving the order via
  `OrdersService.transitionTx` in one tx, dispatch board, `LogisticsProvider` port (manual adapter only); analytics (`/analytics`:
  summary vs previous period, series, channels, sessions with seller-recorded viewers only, top products), CSV + PDF (pdfkit), plan-gated
  on `features.analytics`. API unit 117/117, e2e 193/193 (+4 live-Veltrix, opt-in), web 28/28.
- Phase 10b (same sign-off, see `docs/PHASE-10.md` §10b): private couriers (`couriers`, picked per delivery, phone shown only if
  chosen); analytics tiers (`features.analytics`: standard ≤ 92 days + CSV; advanced = Business/Enterprise/Pay as you sell: 366 days,
  PDF, weekday×hour, top customers, weekly/monthly email reports via `report_schedules`); Pay as you sell = full app, no fee, no
  limits, commission on every sale — split at source, DIRECT/bank transfer invoiced monthly (`CommissionBillingService`,
  `InvoiceKind.COMMISSION`), overdue + grace → 402 `COMMISSION_OVERDUE`. API unit 123/123, e2e 201/201, web 29/29.
- Phase 10 signed off. Phase 11 BUILT, awaiting sign-off (see `docs/PHASE-11.md`): super-admin portal `/admin` (overview, sellers +
  suspend/reactivate, verification queue, plans, payment providers + commission invoices with waive, audit log, settings, webhooks,
  sales enquiries); API `src/admin/` (SUPPORT reads, ADMIN writes, all audited). API unit 123/123, e2e 205/205, web 29/29.
- Phase 11 signed off. Phase 12 BUILT, awaiting sign-off (see `docs/PHASE-12.md`, `docs/DEPLOYMENT.md`): security review (§23), prod config
  guard (`src/config/production-checks.ts`), JSON logs + X-Request-Id + `ErrorReportingFilter`/`ALERT_WEBHOOK_URL`, web Dockerfile,
  `docker-compose.prod.yml` + migrate job, `infra/nginx/prod.conf` (TLS), backup/restore scripts (drilled), CI workflow, k6 script,
  multer override (audit clean). API unit 127/127, e2e 211/211, web 29/29.
- Phase 12 signed off. Mobile phase BUILT, awaiting sign-off (see `docs/PHASE-13-MOBILE.md`): `apps/mobile` Expo SDK 58 (expo pinned 58.0.19),
  Expo Router, outside npm workspaces (own lockfile); mobile sessions (`X-Client-Type: mobile`, refresh token in SecureStore, access
  token in memory); Today, Orders + order actions (transfer confirm, delivery, reminder), Live console (orders by product code), Stock,
  store switcher; round 2: push (`src/push/`, Expo push service via outbox; `/me/devices`), offline order queue (`orders.client_ref` idempotency),
  sign-up, product edit/photos/stock, settings, analytics, billing in-app, branding, `docs/STORE-LISTING.md`. Mobile jest 12/12; API unit 128/128,
  e2e 216/216. Not device-tested; FCM/APNs keys and `eas init` pending.
- Commission invoices are debts for past sales: never void them in plan changes or expiry, and paying one never changes the plan.
- Delivery fees for customer orders are computed server-side only; never accept a fee from the storefront or WhatsApp client.
- Order messages come only from the outbox (`customerEvent()` in `orders.service.ts`); never send order updates from controllers.
  WhatsApp goes only to opted-in customers without `whatsapp_opt_out_at`; outside 24 h only via an approved template.
- Send messages only through `NotificationService.send()`; pass `secret: true` for codes/links and a `dedupeKey` per business event.
- An order becomes PAID only via `OrdersService.markPaid()/markPaidTx()` — call it only after server-side payment verification
  (Phase 5 webhooks/verify, Phase 7 transfer verification), in the same transaction that records the payment and ledger journal.
- Legal text lives in `apps/web/src/content/legal.ts`; bump its version and `apps/api/src/legal/versions.ts` together.
- Money is recognised only in `PaymentsService.applyVerification()` (provider verify response, exact amount + currency, payment row
  locked, ledger + `markPaidTx`/`applyPaidInvoiceTx` in the same transaction). Webhooks only trigger a verify. New providers
  (Phase 6) = a new adapter + registry entry; never call `markPaidTx` from anywhere else except Phase 7 transfer verification.
- E2E suites override `PaymentProviderRegistry` with `FakePaymentProvider` (`test/support.ts`, one per provider code, real adapters'
  key formats/capabilities/webhook checks); `test/env.js` sets placeholder platform keys so the real ones in `apps/api/.env`
  are never used by the app under test. Real sandbox suites: `test/{paystack,flutterwave,bachs}-sandbox.e2e-spec.ts`. `test/paystack-sandbox.e2e-spec.ts` hits the
  real Paystack test API with the key from `apps/api/.env` (skipped without a `sk_test_` key; live keys refused).
- Work proceeds one phase at a time, in the order in MASTER-SPEC §28. Do not start a phase until the previous one's tests pass.

## Stack (fixed — do not swap)
- `apps/api`: NestJS 11, TypeScript strict, Prisma 7 (`prisma-client` generator, `@prisma/adapter-pg`), Postgres 16, Redis, BullMQ.
- `apps/web`: Next.js 16 (App Router), React 19, TypeScript, Tailwind v4. Access token in memory only (`src/lib/api.ts`); refresh token
  stays in the API's httpOnly cookie. Design tokens in `src/app/globals.css`, components in `src/components/ui.tsx`. 3D only in the
  landing hero (lazy, desktop-only).
- npm workspaces. Node 22+.
- `apps/mobile`: Expo (SDK 58) React Native + TypeScript seller app on the same `/api/v1` (mobile sessions via `X-Client-Type: mobile`). Not an npm workspace: `cd apps/mobile && npm install`; always `npx expo install <pkg>`; read `apps/mobile/AGENTS.md`.

## Commands
```bash
docker compose up -d postgres redis minio minio-init   # MinIO: S3 API :9000, console :9001
cd apps/api
npx prisma generate
npx prisma migrate deploy && npm run seed
npm run start:dev                     # :4000, Swagger at /api/docs
npm test                              # unit
npm run test:e2e                      # real Postgres (livesell_test) + Redis; rebuilds DB from migrations
npx tsc --noEmit && npx nest build    # must pass before finishing any task
npm run seed:demo                     # dev only: demo@livesell.local / DemoSeller2026 with ~300 orders

cd apps/web
npm run dev                           # :3000 (NEXT_PUBLIC_API_URL, default http://localhost:4000)
npm test && npx tsc --noEmit && npx next build
```
Tenant-scoped writes are blocked with 402 when the subscription is inactive; billing-recovery and security routes opt out with
`@AllowInactiveSubscription()`. Use `prisma.tenantTransaction(tenantId, fn)` for interactive transactions in seller-facing code.
New schema changes: `npx prisma migrate dev --name <change>`. Never edit an applied migration.

## Object storage
- Dev and tests: MinIO (buckets `livesell-media`, `livesell-media-test`). Staging/prod: Cloudflare R2 or AWS S3.
- Code uses `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` only, configured by `S3_*` env vars. No vendor-specific SDKs.
- Uploads: server issues a short-lived presigned PUT with content-type and max-size constraints; key prefix is `tenants/<tenantId>/...`; the server confirms the object exists (HEAD) before saving the key. Allow only image types for logos.

## Non-negotiable rules
1. **Tenant isolation.** Seller-facing services use `prisma.forTenant(tenantId)` only. The raw client is for auth and platform-admin code. Tenant comes from `@CurrentTenant()`, never from body/query. Any new model with `tenantId` must be added to `TENANT_SCOPED_MODELS` (a unit test enforces this). When linking records by id (connect, foreign keys), verify the target belongs to the same tenant.
2. **Routes:** declare access with `@Public()`, `@TenantScoped()`, `@RequirePermissions(...)` or `@RequirePlatformRole(...)`. New permissions go in `src/rbac/permissions.ts` and the right `SYSTEM_ROLES`.
3. **Money:** BIGINT minor units (kobo) + 3-letter currency. No floats, ever. Serialized as strings.
4. **Payments:** an order is PAID only after server-side provider verification or a signature-verified webhook. Never on redirect or screenshot. Every money movement posts a balanced ledger journal in the same DB transaction. Use idempotency keys and the existing unique constraints.
5. **Providers behind ports.** `PaymentProvider` interface + one adapter per provider (Paystack, Flutterwave, Bachs, BankTransfer). Veltrix behind a `MessagingProvider` port; the existing `AuthMailer` port gets a Veltrix adapter in Phase 8. Business logic never imports a provider SDK.
6. **No invented APIs.** Read official provider docs (links in MASTER-SPEC §12) before coding an adapter. If docs or credentials are missing (Veltrix, Bachs), build the adapter against the port, mark it feature-flagged off, and list it as blocked in the phase report. Never claim an integration works without a sandbox test.
7. **Secrets:** encrypt with `CryptoService.encrypt(value, tenantId)`; never return secrets to the browser; never log them (audit metadata is auto-redacted — keep key names descriptive).
8. **Stock:** reserve and release inside a transaction using `SELECT … FOR UPDATE` on the inventory row. The DB CHECK `reserved <= on_hand` is the backstop, not the mechanism.
9. **Audit:** `AuditService.record()` for every security- or money-relevant action.
10. **TikTok/Instagram data:** use only official APIs and permissions. Product-code ordering and manual order entry are the default. Never fabricate viewer counts or conversion rates.

## Code style
- One Nest module per domain under `src/<domain>/`: thin controllers, logic in services, DTOs with class-validator (`whitelist` + `forbidNonWhitelisted` is on globally).
- Swagger decorators on every endpoint.
- Real data only in UI; seed data only in development.
- No dead buttons in the frontend; every screen has loading, empty, error and success states.

## Definition of done (every phase)
- Unit + e2e tests for the phase's critical paths (MASTER-SPEC §26 scenarios as they become relevant), all passing together with every earlier test.
- `tsc --noEmit` and `nest build` clean.
- `docs/PHASE-<n>.md` written: what was built, files created/changed, tests, and what's blocked or incomplete.
- Update this file's Status section.
- Stop and summarise. Wait for my go-ahead before the next phase.
