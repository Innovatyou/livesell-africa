# LiveSell Africa — Architecture

## Repository

```
livesell-africa/
├─ apps/api/            NestJS 11 · TypeScript · Prisma 7 (Postgres 16) · Redis
│  ├─ prisma/           schema.prisma · migrations/ · seed.ts
│  ├─ src/
│  │  ├─ config/        zod-validated env (boot fails on weak/missing secrets)
│  │  ├─ prisma/        PrismaService + tenant-scope extension
│  │  ├─ common/        auth guards & decorators · crypto (AES-256-GCM) · audit
│  │  ├─ rbac/          permission catalogue · system roles
│  │  ├─ auth/          register · login · refresh rotation · verify · reset
│  │  ├─ tenants/       workspace endpoints
│  │  ├─ storage/       S3-API presigned uploads (MinIO / R2 / S3)
│  │  ├─ onboarding/    checklist · store profile · logo · business verification
│  │  ├─ staff/         invitations · member management
│  │  ├─ billing/       plans · subscriptions · lifecycle job (BullMQ) · entitlements
│  │  ├─ payments/      PaymentProvider port, Paystack/Flutterwave/Bachs adapters, payments service, reconciliation job
│  │  ├─ ledger/        double-entry journals (chart of accounts + recipes)
│  │  ├─ messaging/     MessagingProvider + VerificationProvider ports, Veltrix adapters
│  │  ├─ notifications/ NotificationService (send, retry, limits, usage), templates, Veltrix AuthMailer/BillingNotifier
│  │  ├─ dashboard/     §7 seller dashboard
│  │  └─ health/        /health/live · /health/ready
│  └─ test/             e2e suite (real Postgres + Redis)
├─ apps/web/            Next.js 16 App Router · Tailwind v4 (landing, pricing, auth, onboarding, dashboard, settings)
├─ infra/nginx/         reverse proxy
└─ docker-compose.yml   dev stack
```

Each later domain (products, orders, payments, notifications…) is its own Nest module under `src/`, with
controllers thin and logic in services. Payment providers and Veltrix sit behind ports (interfaces) with
one adapter per provider, so business logic never imports a provider SDK.

## Request pipeline

Guards run in this order on every request:

1. **Throttler** — global limit; stricter limit on `/auth/*`. Nginx adds a second layer.
2. **JwtAuthGuard** — HS256, issuer/audience pinned, 15-min TTL. User status re-read per request so
   suspension is immediate. `@Public()` opts out.
3. **PlatformRoleGuard** — `@RequirePlatformRole('PLATFORM_ADMIN')` for the admin portal.
4. **TenantGuard** — reads `X-Tenant-Id` as a *selector only*; loads the membership from the DB and
   rejects unless the member and tenant are both active. Same 403 for "not yours" and "doesn't exist".
5. **PermissionsGuard** — `@RequirePermissions('orders:create')` checks the role's permissions.
6. **SubscriptionGuard** — tenant-scoped writes need a live subscription (TRIALING / ACTIVE / PAST_DUE in grace);
   otherwise 402 `SUBSCRIPTION_INACTIVE`. Reads always work. `@AllowInactiveSubscription()` for billing recovery
   and security actions.

## Tenant isolation — three layers

| Layer | Mechanism |
|---|---|
| HTTP | TenantGuard validates membership server-side; tenant id never trusted from the client |
| Query | `prisma.forTenant(id)` Prisma extension injects `tenantId` into every where/create on the 32 tenant-owned models, overrides caller-supplied ids, rejects cross-tenant writes. A unit test fails if a new model with `tenantId` isn't registered. |
| Data | Every tenant table has `tenant_id` + composite indexes; uniques are per tenant (`tenant_id, product_code`) |

Rule for services: seller-facing code uses `forTenant()`. The raw client is for auth and the platform admin only.

## Sessions

- Access token: JWT, 15 min, in memory on the client.
- Refresh token: 256-bit opaque, stored as HMAC-SHA256 hash. Web gets it in an `httpOnly`,
  `SameSite=Strict` cookie scoped to `/api/v1/auth`; mobile opts in with `X-Client-Type: mobile`.
- Rotation on every refresh. Replaying a used token revokes the whole token family (theft detection).
  Concurrent refresh with one token: only one wins (atomic claim).
- Password reset revokes all sessions. Verification/reset tokens are single-use, hashed, short-lived.

## Money & financial integrity

- All amounts are `BIGINT` minor units (kobo) + ISO-4217 currency; serialized to JSON as strings.
- DB `CHECK` constraints: no negative prices/totals/stock; `reserved ≤ on_hand` (oversell guard even if
  app code is wrong).
- Double-entry ledger: a deferred constraint trigger rejects any unbalanced journal at commit.
  Ledger entries and audit logs are append-only (DB triggers).
- Webhooks: `UNIQUE(provider, event_id)` makes duplicate deliveries a no-op.
- Transactions: unique `reference`, `idempotency_key`, and `(provider, provider_reference)`.
- SaaS subscription revenue and seller sales share the transaction table but are separated by `purpose`
  and post to different ledger accounts.

## Secrets

- Gateway credentials, bank account numbers, MFA secrets: AES-256-GCM, with the tenant id as AAD so
  a ciphertext copied into another tenant's row won't decrypt. Only last-4 of account numbers in clear.
- Platform secrets via env (validated at boot); production should source them from a secret manager.
- Audit metadata is recursively redacted (passwords, tokens, keys, PINs, account numbers).

## Decisions to revisit

- **Composite FKs** `(tenant_id, id)` on child tables would make cross-tenant references impossible at the
  DB level, not just the service level. Worth adding before Phase 4 (orders).
- **Postgres RLS** as a fourth isolation layer once the query patterns settle.
- Tenants and users are closed/suspended, never hard-deleted (audit logs are append-only and reference them).

## Object storage

- S3 API only (`@aws-sdk/client-s3` + presigner), configured by `S3_*`. MinIO in dev/tests, R2 or S3 in production.
- Keys: `tenants/<tenantId>/logos/…` (public media) and `tenants/<tenantId>/private/…` (documents). The dev bucket
  policy makes only `tenants/*/logos/*` anonymously readable; private files are served by short-lived presigned GET.
- Upload: presigned PUT (5 min, content type + exact size signed) → client uploads directly → server confirms the key
  was issued to this tenant (single-use Redis record), HEADs it, checks size/type and magic bytes, deletes anything
  invalid, and only then stores the key.

## SaaS billing

- Plans are global, admin-editable rows; subscriptions/invoices/events are tenant-scoped. At most one live
  subscription per tenant (partial unique index).
- Changes: trial → immediate; upgrade → prorated invoice, applied when paid; downgrade → at period end (must fit
  usage). Invoices become PAID only through `SubscriptionsService.applyPaidInvoiceTx()`, which `PaymentsService` calls
  after server-side verification of a payment made through the platform Paystack account.
- A BullMQ job scheduler runs the lifecycle every 15 minutes (trial end, renewal, grace expiry, reminders). Every
  transition is a guarded conditional update and reminders use unique dedupe keys, so concurrent workers are safe.

## Web sessions

- Access token in JS memory only; refresh token in the httpOnly SameSite=Strict cookie (`/api/v1/auth`).
- Refresh is single-flight per tab and serialised across tabs with Web Locks — required because a replayed refresh
  token revokes the whole session family.
- The selected workspace id (localStorage) is only a selector for `X-Tenant-Id`; the API validates membership.

## Catalogue and stock

- Every sellable unit is a variant with its own `inventory` row. All stock changes go through `InventoryService`:
  rows are locked with `SELECT … FOR UPDATE` (in variant-id order to avoid deadlocks), every change writes an
  append-only `inventory_movements` row with the balances after it, and stock can never drop below units reserved for
  open orders. The DB CHECKs (on hand ≥ 0, reserved ≤ on hand) are the backstop.
- Product codes (e.g. BAG001) are upper-case and unique per store, never reused, and stay reserved after deletion.
- The public storefront API (`/api/v1/store/:slug`) resolves the store by slug, then uses the tenant-scoped client; it
  hides drafts, inactive variants, cost prices and exact stock, and returns the same 404 for missing, unpublished,
  suspended and lapsed stores.

## Orders

- Status machine in `src/orders/order-rules.ts`: people confirm, cancel and move fulfilment forward; only the payments
  module (after server-side verification) sets PAID, payment verification or refunds — via `OrdersService.markPaid()`.
- Confirming reserves stock in the same transaction; cancelling releases it; dispatch/delivery converts it to a sale
  once. The order row is locked (`SELECT … FOR UPDATE`) for every change; history rows are append-only.
- Unpaid orders hold stock until `reservation_expires_at`; a BullMQ job (every 5 min, idempotent) cancels and releases.
- Storefront checkout re-prices from the database and returns a random tracking token; only its HMAC is stored.

## Payments (Phase 5)

- **Port and adapters.** Business logic depends on `src/payments/payment-provider.ts` only. `PaystackAdapter` is the
  one place that talks to Paystack (plain `fetch`, 15 s timeout; network errors, 5xx and 429 become
  `ProviderUnavailableError` → 503 `PROVIDER_UNAVAILABLE`). `PaymentProviderRegistry` maps codes to adapters; a provider
  is usable only when its `payment_providers` row is enabled by a platform admin. Tests swap the registry for a fake.
- **Settlement.** DIRECT: the seller's own Paystack secret key, validated with Paystack and stored with
  `CryptoService.encrypt(key, tenantId)`. SPLIT: the platform key plus a Paystack subaccount that settles to the
  seller's bank; the platform's commission is sent as a flat `transaction_charge`, and the subaccount bears the fee.
- **Recognising money (rule 4).** Customer return, webhook, staff "check payment" and the reconciliation job all
  end in `PaymentsService.applyVerification()`. It trusts only Paystack's server-side verify response, requires the
  exact amount and currency, and in one transaction with the payment row locked: records the result, posts the
  ledger journals and calls `OrdersService.markPaidTx()` or `SubscriptionsService.applyPaidInvoiceTx()`. A payment
  that arrives for a cancelled or already-paid order is recorded and flagged for refund, never applied.
- **Webhooks** are only a hint to verify. Raw bodies are kept for `/webhook` routes; signatures are checked per
  account (seller key on `/webhook/:accountId`, platform key on `/webhook`); events are de-duplicated on
  `(provider, event_id)`. Processing is off until `PAYSTACK_WEBHOOKS_ENABLED=true`.
- **Reconciliation.** A BullMQ job every 10 minutes re-verifies open payments (for 48 h, then abandons them) and
  settles refunds that are still processing.
- **Refunds.** Requested with an idempotency key; the amount still in flight counts against what's refundable. The
  ledger reversal and the order's REFUNDED / PARTIALLY_REFUNDED status are applied only when Paystack reports the
  refund complete. A full refund of goods that haven't been dispatched releases their reserved stock.
- **Ledger.** Seller (tenant) and platform (tenant_id NULL) books are separate journals, each balanced on its own;
  recipes in `src/ledger/ledger.service.ts` are pure and unit-tested. Accounts — seller: SALES_REVENUE,
  SALES_REFUNDS, GATEWAY_CLEARING, PAYMENT_FEES, COMMISSION_EXPENSE, COMMISSION_PAYABLE (DIRECT only); platform:
  SUBSCRIPTION_REVENUE, COMMISSION_REVENUE, COMMISSION_RECEIVABLE (DIRECT), PLATFORM_GATEWAY_CLEARING,
  PLATFORM_PAYMENT_FEES. Commission is fixed when the payment starts and reversed in proportion on refunds (exactly
  in full on the last one).
- **DB backstops.** Balanced-journal trigger, append-only entries, no deletes on transactions/refunds/webhook events,
  `proceeds + commission + fee = gross`, unique references, idempotency keys and `(provider, provider_reference)`.

### Several providers (Phase 6)

- Adapters: `PaystackAdapter`, `FlutterwaveAdapter` (v3 Standard), `BachsAdapter` (REST; the Bachs SDK lacks refunds
  and Connect). Each declares `capabilities` (split, multiple refunds, minimum refund, webhook secret source, public
  callback requirement) and `keyMode()`; the service reads these instead of branching on provider names.
- Amounts: the port is always BigInt kobo. Flutterwave (JSON numbers in naira) and Bachs (decimal strings) are
  converted exactly by `src/payments/money-decimal.ts`; amounts that decide "paid" must be exact, fees may round.
- A store can connect one account per provider; one is the default. `sellerRoute()` picks the default active account
  on a provider the platform has enabled, falling back to the next one.
- Seller credentials are stored as encrypted JSON `{ secretKey, webhookSecret? }` (`CryptoService`, tenant-bound AAD).
  Phase 5 accounts holding a bare key are still read.
- Verification inputs differ per provider: Paystack and Flutterwave look up our reference; Bachs needs its checkout
  id, stored as `payment_transactions.provider_checkout_id` when the payment starts.
- Webhooks: `/payments/:provider/webhook(/:accountId)`. Paystack HMAC-SHA512 with the secret key (flag off);
  Flutterwave `verif-hash` = the secret hash; Bachs `X-Bachs-Signature-V2` HMAC-SHA256 of `t.body` with the endpoint
  signing secret, 300 s window. All of them only trigger a verify.

## Bank transfer and reconciliation (Phase 7)

- **Accounts.** `bank_accounts.for_transfers` marks the accounts customers pay into (split-settlement accounts stay
  private). Numbers are encrypted with the tenant-bound key; names are confirmed with the bank through a provider's
  account resolution when the platform has a key. At most one default (partial unique index).
- **Reports, not payments.** A customer (tracking token) or staff member reports a transfer, optionally with a receipt
  (private S3 prefix `tenants/<id>/private/transfers/`, presigned PUT, HEAD + magic-byte check, single use). That
  creates a `BANK_TRANSFER` transaction in `PENDING` with `transfer_evidence` (DB check: required), moves the order to
  `PAYMENT_VERIFICATION` and holds stock for `orders.transfer_hold_hours` (72 h).
- **Verification.** Only `payments:verify_transfer` can verify, and only for exactly the order total. In one
  transaction with the payment row locked: SUCCEEDED + `verified_by = user:<id>`, ledger (`SELLER_BANK` debit, sales
  credit, commission owed), `OrdersService.markPaidTx`. Rejecting returns the order to `PENDING_PAYMENT` when no other
  report is pending. A late verification on a cancelled order is recorded and flagged for refund, never applied.
- **Refunds of transfers** are made by the seller from their bank and recorded with a required description; the
  reversal posts against `SELLER_BANK` at once.
- **Reconciliation** (`ReconciliationService`, read-only, tenant-bound SQL) checks: every verified payment has its
  sale journal for the gross; completed refunds match the refund journal; paid orders have a verified payment; stray
  payments are refunded; reported transfers are checked in time (`payments.transfer_stale_hours`) and not left on
  cancelled orders; provider refunds complete. Seller report at `/payments/reconciliation`, platform summary for
  admins, daily job (02:30 Africa/Lagos) that audits stores with issues.

## Messaging (Phase 8, Veltrix)

- **Ports.** `MessagingProvider` (email, SMS, WhatsApp, SMS delivery receipts, status) and `VerificationProvider`
  (CAC/TIN registry check) in `src/messaging/messaging-provider.ts`; Veltrix adapters in `veltrix.adapter.ts`, written
  against the Veltrix source (`config/api/routes.php`, `docs/API.md`): `/transactional-emails`, `/sms-tools/quick-send`,
  `/whatsapp/send`, `/sms-tools/logs?message_id=`, Verify `/api/verify/v1/kyc/business`. Inert while
  `VELTRIX_ENABLED=false`; `AuthMailer`/`BillingNotifier` then stay on the development log adapters.
- **One row per message.** `NotificationService.send()` writes a `notifications` row, then sends with the
  `Idempotency-Key` `ls-<id>-<seq>`. The seq moves on only after a *definite* failure, so an ambiguous one (timeout)
  is retried under the same key and Veltrix replays instead of sending twice. Temporary failures retry at 1 m, 5 m,
  25 m and 2 h (job every minute, leased so one worker sends each row); after 5 attempts the row is FAILED. Sending
  never throws into the business flow (§26 #10), except the OTP, which the person is waiting for.
- **Secrets are not stored.** OTP codes and verification / reset / invitation links are rendered in memory; their
  rows keep `payload = {}` and `retryable = false`.
- **Usage and limits.** Seller-attributed messages get a `notification_usage` row priced from
  `messaging.price_kobo`; `messaging.monthly_limits` (or a plan's `limits.messaging`) caps each channel per Lagos
  calendar month. `dedupe_key` (unique) makes a repeated business event a no-op. SMS delivery receipts are polled every
  10 minutes.
- **Admin.** `/admin/integrations` (web) shows the Veltrix account and wallet, channels and Verify, a test send,
  prices and limits, seller usage, and failed messages with retry.

### Veltrix-side changes (repo `mailwizz-yii3`)
Additive only: optional `Idempotency-Key` on `POST /transactional-emails`, `/sms-tools/quick-send` and
`/whatsapp/send` (`ApiIdempotencyMiddleware`, `ApiIdempotencyService`, migration `174_api_idempotency.sql`, pruned
daily); quick-send returns per-recipient `results` with `message_id`; `GET /sms-tools/logs` accepts `message_id`;
`docs/API.md` documents the one-off send endpoints. Check: `php tools/api_idempotency_check.php`.

## Order messages and WhatsApp ordering (Phase 9)

- **Outbox.** `OrdersService.history()` writes an `outbox_events` row in the same transaction as each customer-relevant
  status change (`customerEvent(from, to)`). The `automation` queue runs `OrderNotifier.dispatchOutbox()` every 15 s
  (rows claimed by compare-and-set on `attempts`, max 5) and `runReminders()` every 10 minutes. Rolled-back changes
  never message; committed ones are never lost. Payment confirmation therefore follows server-side verification only.
- **Channel plan** (`automation/preferences.ts`, pure): WhatsApp only for opted-in customers who haven't sent STOP —
  free text inside Meta's 24 h window (last inbound in `whatsapp_conversations`), otherwise the approved template mapped
  in `whatsapp.templates` with positional values (`WHATSAPP_PARAMS`); SMS as the fallback; email in addition. Store
  preferences in `notification_preferences`. Dedupe key `order:<id>:<event>[suffix]:<channel>`.
- **Links.** Storefront/WhatsApp orders keep the tracking token encrypted (`tracking_token_enc`, tenant-bound) beside
  its hash so messages can carry the private order link.
- **Inbound WhatsApp.** Veltrix forwards the platform number's messages (migration 175) to `POST /api/v1/whatsapp/webhook`,
  signed `X-Veltrix-Signature: t=…,v1=HMAC-SHA256("t.body")` with a secret kept encrypted in `whatsapp.forwarding`;
  de-duplicated in `whatsapp_inbound_events`. `WhatsappCommerceService` keeps one conversation per phone (state machine,
  24 h TTL, 30 msgs / 10 min) and places orders through `OrdersService.create(source: 'whatsapp')` — database prices,
  `FOR UPDATE` stock reservation, checkout hold. STOP/START set `customers.whatsapp_opt_out_at` for every store.
- **Veltrix side.** `WhatsappForwardService` (queue + retries via `whatsapp/forward-dispatch`), forwarding API
  `GET/PUT/DELETE /whatsapp-servers/{uid}/forwarding`; with forwarding on the bot/AI agent are bypassed. Check:
  `php tools/whatsapp_forward_check.php`. Veltrix verifies Meta's `X-Hub-Signature-256` (migration 176) and forwards only verified messages, so the platform number needs its Meta app secret set in Veltrix (`php tools/whatsapp_meta_signature_check.php`).



## Logistics (Phase 10)

- **Zones and pricing.** `delivery_zones` (states and/or cities, kobo fee, days) + `storefront_settings.delivery_settings`
  (pickup address, out-of-zone policy). `matchZone()` (pure): city match beats state match, cheaper wins, inactive never
  matches. `DeliveryService.priceFor()` prices every customer order (storefront checkout, WhatsApp) — the client never
  sends a fee — and `OrdersService.create()` writes the fee and the `delivery_orders` row in the same transaction.
- **Delivery records.** Method (pickup / own / courier), carrier, tracking, notes, status
  (`DELIVERY_TRANSITIONS`). A delivery move and the order transition share one transaction via
  `OrdersService.transitionTx()`: IN_TRANSIT dispatches (stock commit, history, outbox `ORDER_DISPATCHED` with carrier +
  tracking), DELIVERED delivers; FAILED/RETURNED add a history note only. Moving the order directly syncs the delivery.
  Only paid orders ship.
- **Port.** `LogisticsProvider` + `LogisticsRegistry`; only `ManualLogisticsAdapter` exists until a courier API is approved.

## Analytics (Phase 10)

- `AnalyticsService.report()` — raw SQL with the tenant id bound and every joined table filtered by it; orders by
  creation day (Africa/Lagos), store currency; paid = PAID/PARTIALLY_REFUNDED/REFUNDED; net = gross − completed refunds;
  rates in basis points; previous period of equal length; series by day/week/month. Session conversion only with
  recorded peak viewers (`viewerData: seller_reported`), never estimated.
- Exports: CSV per table (`analytics-export.ts`, naira, no personal data) and a PDF (`pdfkit`, standard fonts, "NGN"
  amounts), both audited. Gated by the plan's `features.analytics`; the §7 dashboard stays on every plan.


## Commission collection (Phase 10b)

- **Where commission comes from:**
  - Split payments: LiveSell's share is taken at source.
  - DIRECT / BANK_TRANSFER sales accrue `COMMISSION_PAYABLE` (seller) / `COMMISSION_RECEIVABLE` (platform) in the sale's
    transaction.
  - Refunds reverse their share.
- **Monthly invoice:** `CommissionBillingService.issueDue()` runs hourly and is idempotent (advisory lock + partial
  unique index).
  - On each Lagos month start it invoices `owedNet(entries on ORDER transactions before the cutoff) − Σ earlier
    commission invoices`, when that is at least the minimum.
  - The invoice is paid through the platform account. `commissionSettlementJournals()` clears payable and receivable in
    the verification transaction.
- **Overdue:** in `SubscriptionGuard`, an OPEN commission invoice past due + `billing.grace_days` blocks tenant writes
  (402 `COMMISSION_OVERDUE`).

## Analytics tiers and email reports (Phase 10b)

- **Tiers:** `TIER_LIMITS` in `analytics-math.ts` (standard / advanced) gate range length, PDF, patterns, top customers
  and schedules.
- **Email reports:** `ReportSchedulesService.runDue()` runs hourly, from 07:00 Lagos.
  - It reports the last complete ISO week or month.
  - Each recipient gets it once per period (dedupe key).
  - Recipients are re-checked for `reports:read` at send time.
