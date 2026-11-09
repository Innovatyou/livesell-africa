# Phase 2 report — seller onboarding, subscription plans, dashboard, web app

Scope: MASTER-SPEC §28 Phase 2 ("Seller registration, onboarding, subscription plans and dashboards"), with §6, §7,
§14 and §24, and the Decisions box at the top of the spec.

## Status at a glance

| Area | State |
|---|---|
| Unit tests (API) | **29 / 29 passing** (13 Phase 1 + 16 new) |
| Frontend tests (web, Vitest) | **11 / 11 passing** |
| E2E (API, real Postgres + Redis + S3) | **58 / 58 passing**, with the storage tests run against a real AWS S3 bucket (eu-west-1). All 21 Phase 1 tests still pass. |
| `tsc --noEmit` / `nest build` | clean |
| `next build` (web) | clean, 18 routes |
| Drift check after the new migrations | empty (`-- This is an empty migration.`) |

**Before treating Phase 2 as done:** run `docker compose up -d postgres redis minio minio-init`, then
`npm run test:e2e`. All 58 should pass. Until that run, the presigned-upload code is unverified against real S3
storage. It builds and is unit-tested, but has only been exercised up to presigning.

## Step 0 — Phase 1 verified on this machine

The build machine has no Docker, so Laragon's Postgres **18** and Redis **5.0.14** stood in. I added a `livesell` role
and `livesell` / `livesell_test` databases; nothing else on that instance was touched.
`prisma generate` → `migrate deploy` on a fresh DB → `seed` → drift check: **empty**, so the init migration was not
regenerated. `npm test` 13/13 and `npm run test:e2e` 21/21. Re-run on a recreated database at the start of this phase:
same result.

## What was built

### API (`apps/api`)

**Onboarding (§6)**
- `GET /onboarding`: guided checklist computed from real rows each time, not stored flags. Steps: verify email,
  verify phone, store profile (description + WhatsApp), logo (all required); invite team and business verification
  (optional). Products, storefront publishing and payments get checklist items in the phases that build them.
- `GET/PATCH /store/profile`: business details, contact, WhatsApp, social handles. The website must be `https://`;
  `javascript:` URLs and markup in handles are rejected.
- Logo upload (S3 API only, `@aws-sdk/client-s3` + `s3-request-presigner`):
  1. `POST /store/logo/upload-url` validates the type (PNG/JPG/WebP; **SVG refused**) and size (≤ 2 MB). It returns a
     5-minute presigned PUT with **Content-Type and the exact Content-Length signed**. The key is
     `tenants/<tenantId>/logos/<uuid>.<ext>`. A single-use pending record goes in Redis.
  2. The browser PUTs directly to storage.
  3. `PUT /store/logo` checks that the key belongs to this tenant and purpose, then consumes the pending record (single
     use). It HEADs the object and checks size and type match, then reads the first 16 bytes and **checks magic bytes**.
     Anything that fails is deleted. Only then is the key saved; the old logo is deleted.
  - Checksums are set to `WHEN_REQUIRED`, so the same presigned URLs work on MinIO, R2 and S3 with env changes only.
- Phone OTP: `POST /auth/phone/send-otp` (can set or change the number) and `POST /auth/phone/verify`.
  - 6-digit code from `crypto.randomInt`, stored as a salted HMAC, valid 10 minutes.
  - **5 attempts per code**, with an atomic guarded increment so parallel guesses can't exceed the cap.
  - 60 s resend cooldown and 5 codes per hour per user (Redis).
  - Returns **503** when no SMS provider is configured (production until Veltrix) instead of claiming a code was sent.
- Business verification (optional):
  - The seller uploads the CAC certificate (PDF/PNG/JPG ≤ 5 MB) to a **private** prefix,
    `tenants/<id>/private/verification/…`, and submits the RC/BN number.
  - One pending request per tenant (partial unique index).
  - Platform staff review via `GET /admin/business-verifications`, and see a detail view with a short-lived presigned
    document link. Only `PLATFORM_ADMIN` can approve or reject; approval sets `tenants.verified_at`.

**Staff invitations (§5)**
- Owner endpoints (`staff:manage`):
  - `POST /staff/invitations` (Store manager / Sales assistant / Live moderator; never Owner).
  - `GET` lists invitations; `…/resend` rotates the link; `DELETE` revokes.
  - `PATCH /staff/members/:id` changes the role or disables / re-enables a member. The owner and yourself are
    protected. Disabling takes effect on the next request.
- Invitee endpoints:
  - `POST /invitations/lookup`: the token goes in the body, never the URL path.
  - `POST /invitations/accept`: signed-in user; the account email must match the invite.
  - `POST /invitations/accept-new`: creates the account (email counts as verified because the token was emailed),
    joins the team and signs the user in with the same httpOnly cookie as login.
- Tokens: 32-byte random, HMAC-hashed, 7-day expiry, single use (atomic claim).
- **Seat limits come from the plan.** Pending invitations count as seats. A per-tenant advisory lock stops two
  concurrent invites from taking the last seat. Starter (1 seat) therefore allows the owner only.

**Subscription plans and billing (§14)**
- `GET /plans` (public).
  - Prices are kobo strings; `null` means custom pricing.
- `GET/POST/PATCH /admin/plans` (`PLATFORM_ADMIN`).
  - Strict validation: every limit key must be present (`null` = unlimited), prices are digit strings, feature flags
    are short keys with boolean or label values.
  - Price changes are audited with before/after values and apply to invoices issued afterwards.
  - Plans are deactivated, never deleted.
- Seller endpoints (`billing:manage`): `GET /billing/subscription|invoices|history`;
  `POST /billing/subscription/change|cancel-pending-change|cancel|resume`; `POST /billing/invoices/:id/pay`.
- Plan change rules (BigInt kobo maths, unit-tested):
  - **Trial:** switch immediately, free; the trial end date doesn't move.
  - **Active upgrade, same interval:** a prorated UPGRADE invoice for the rest of the period (rounded *up* to the kobo).
    The plan switches **only when the invoice is paid**.
  - **Monthly → annual:** a new annual period starts now; unused monthly time is credited (rounded *down*, floor ₦0).
  - **Downgrade, equal price, or any annual → monthly change:** scheduled for period end. It is refused with
    `USAGE_EXCEEDS_PLAN` if current usage (seats incl. pending invites, products) doesn't fit the new limits.
  - **Past due / expired / cancelled:** a full-period invoice for the chosen plan; reactivation happens on payment.
  - A newer change voids the superseded open invoice.
- Lifecycle (`SubscriptionsService.runLifecycle`, run by a **BullMQ job scheduler every 15 min**):
  - Trial end → `PAST_DUE` with a TRIAL_CONVERSION invoice and an overdue email.
  - Period end → apply any scheduled downgrade, then `PAST_DUE` with a RENEWAL invoice.
  - `PAST_DUE` past the grace period (`billing.grace_days`, default 3) → `EXPIRED`; open invoices are voided and an
    expiry email is sent.
  - `cancelAtPeriodEnd` → `CANCELLED` at the end.
  - Renewal and trial reminders at `billing.reminder_days` (default 7/3/1): each (subscription, period, threshold) is
    sent once via a unique dedupe key. A failed send releases the key so the next run retries.
  - Every transition is a guarded conditional update, so concurrent runs and several workers are safe (tested).
- **Entitlement guard (§26 #8):** with no live subscription (`TRIALING`/`ACTIVE`/`PAST_DUE`), tenant-scoped **writes
  return 402** `SUBSCRIPTION_INACTIVE`. Reads keep working. Billing recovery and security actions (disable a member,
  revoke an invite) opt out with `@AllowInactiveSubscription()`.
- **Payments stay behind the port.** `src/payments/payment-provider.ts` defines `PaymentProvider` with the seven §12
  methods and a `PaymentProviderRegistry`. Phase 2 registers no provider, so `paymentCollectionEnabled: false` and
  `/invoices/:id/pay` returns **503 `PAYMENTS_NOT_ENABLED`**.
  - Nothing is ever marked paid.
  - `SubscriptionsService.applyPaidInvoice()` is the single, idempotent hook Phase 5 calls after verifying a payment
    server-side. The e2e tests call it directly to simulate that verified payment.
- Billing emails go through a new `BillingNotifier` port (log adapter; Veltrix in Phase 8).

**Seller dashboard (§7)**
- Endpoints: `GET /dashboard/summary` and `GET /dashboard/sales?period=daily|weekly|monthly|yearly`
  (30 days / 12 weeks / 12 months / 5 years, zero-filled). Permission: `reports:read`.
- **Definitions** (shown in the UI as "verified payments only · West Africa Time"):
  - *Sales today / this month / chart* = gross of `SUCCEEDED` **ORDER** payment transactions, by verification time,
    in the workspace currency, with days in Africa/Lagos. SaaS subscription revenue is never included.
  - *Total orders* = all non-draft orders. *Paid* = payment status PAID or PARTIALLY_REFUNDED.
  - *Pending payments* = PENDING_PAYMENT + PAYMENT_VERIFICATION (count and amount).
  - *Outstanding* = paid but not delivered (PAID, PROCESSING, READY_FOR_DISPATCH, DISPATCHED).
  - *Products sold* = units in paid orders. *Available inventory* = on hand − reserved (active variants, live products).
  - *AOV* = paid order total ÷ paid order count (integer kobo).
  - Top 5 products by units; 5 most recent customers with paid spend; 5 most recent order transactions.
- Model queries use `forTenant()`. The two time-bucket queries are raw SQL with the tenant id as a bound parameter on
  every joined table. A test seeds data in two tenants and checks every figure against the expected values and for
  leaks.

### Schema (2 new migrations, Phase 1 migrations untouched)

- `20261105124743_phase2_onboarding_billing` (generated by Prisma):
  - New tables: `business_verifications`, `subscription_events` (history; dedupe key).
  - Subscriptions gain `pending_plan_id/interval` and `ended_at`.
  - Invoices gain `kind`, `plan_id`, `interval` and `description`.
  - Verification tokens gain `attempts`; invitations gain `accepted_at/by`.
- `20261105124800_phase2_integrity` (hand-written backstops):
  - Non-negative invoice and plan prices, currency format, a valid invoice period, trial days 0–365.
  - **One live subscription per tenant** and **one pending verification per tenant** (partial unique indexes).
  - `subscription_events` can't be updated.
- New tenant models are registered in `TENANT_SCOPED_MODELS` (the registry test passes).
- Seed adds `billing.grace_days` and `billing.reminder_days` (defaults only; admin-edited values are never
  overwritten).

### Web (`apps/web`) — Next.js 16 App Router, React 19, TypeScript, Tailwind v4

- **Design system (§24)** in `globals.css` `@theme`: light canvas, charcoal ink scale, professional green
  (`#0e7a4d`), hairline borders, 14 px card radius, Inter. Components live in `components/ui.tsx`: Button, inputs with
  accessible `Field`, Card, Badge, Alert, Skeleton, Empty and Error states, Logo.
- **Pages:** landing, pricing, terms, privacy, register, login, forgot/reset password, verify email, invite,
  onboarding, dashboard, settings → store profile / team / plan & billing / business verification, and 404. Every
  data view has loading, empty, error and success states. Every button calls a working endpoint; nothing is a dead
  link.
- **Sessions:** the access token lives only in module memory (`lib/api.ts`). The refresh token stays in the API's
  httpOnly, SameSite=Strict cookie.
  - Refresh is single-flight within a tab and serialised across tabs with the Web Locks API, because the API revokes
    the whole session family on a replayed refresh token.
  - A 401 is retried once after refreshing.
  - The active workspace id in localStorage is only a selector; the server validates membership.
  - Post-login redirects are restricted to relative paths (open-redirect safe). All of this is unit-tested.
- **Landing 3D:** `react-three-fiber`, plain three.js primitives, no drei or models.
  - Loaded with `next/dynamic` (no SSR) **only on ≥1024 px screens with WebGL2**, no reduced-motion preference and no
    Save-Data, and only after the page is idle.
  - Rendering stops when the hero is off-screen.
  - Everyone else gets a static illustration. The three.js chunk (243 KB gzip) is not referenced by the landing page's
    initial HTML; initial JS is 186 KB gzip.
- **Dashboard chart:** custom SVG built to the dataviz specs: ≤24 px columns with a 4 px rounded top and square
  baseline, hairline grid, compact naira axis, hover/focus tooltip over the full band, no legend for the single series,
  and a "Show as table" view. The brand green passes the palette validator against the surface.
- Money is formatted with BigInt only (`lib/money.ts`); there is no float anywhere in the money path.
- The pricing page is prerendered from `/plans` with 5-minute revalidation. If the server can't reach the API, it
  loads the plans in the browser instead of caching an error.
- Security headers: nosniff, `X-Frame-Options: DENY`, strict referrer policy, permissions policy.

### Development-only demo data

`npm run seed:demo` (in `apps/api`) creates **demo@livesell.local / DemoSeller2026**: a Professional-trial store with
6 products, 12 customers and about 300 orders with verified payments over 14 months, so the dashboard has something
to show. It refuses to run in production or staging and leaves an existing demo store untouched.

## Tests added

- **Unit:** billing maths (calendar months, per-month comparison, proration rounding both ways, credits, period-end
  rules, reminder thresholds); plan limits and feature validation; upload policy (types, sizes, tenant-bound keys,
  traversal, magic bytes).
- **E2E (`test/phase2.e2e-spec.ts`, 28 tests):**
  - Onboarding: checklist accuracy; profile validation and RBAC.
  - Phone OTP: countdown, single use, 5-attempt lock, cooldown, taken number.
  - Logo uploads to real S3: tenant binding, single use, disguised HTML deleted, size and type signature mismatch.
  - Business verification: private document, presigned admin access, approval.
  - Staff: seat limits incl. pending invites; accept as new and existing user; email mismatch; single-use tokens;
    resend and revoke; owner and self protection; instant disable; cross-tenant 404s.
  - Plans: public listing; admin CRUD validation and audit.
  - Billing: trial switch; prorated upgrade applied only via the payment hook (idempotent); invoice voiding; scheduled
    downgrade with usage check; RBAC.
  - Lifecycle (**§26 #8**): trial → past due → expired → 402 on writes, reads OK → reactivation; renewal with scheduled
    downgrade; scheduled cancel; concurrent-run idempotency; reminder once-only plus retry after a failed send
    (**§26 #10** at the billing-notifier level); BullMQ scheduler registration in Redis.
  - Dashboard: zeros for a new store; every KPI and chart period exact; cross-tenant, draft, failed, SaaS and
    other-currency exclusions; RBAC (**§26 #9**).
- **Web (Vitest):** money formatting incl. values beyond `MAX_SAFE_INTEGER`; refresh single-flight; 401 retry with
  tenant header; sign-out on failed refresh; token never in storage; safe redirects; phone normalisation.

## Files

**New (API):** `src/storage/{storage.module,storage.service,upload-policy,upload-policy.spec}.ts`,
`src/billing/{billing.module,billing.controller,billing.jobs,billing-math,billing-math.spec,billing-notifier,entitlements.service,plans.controller,plans.dto,plans.service,subscriptions.service}.ts`,
`src/payments/payment-provider.ts`, `src/staff/{staff.module,staff.controller,staff.dto,staff.service}.ts`,
`src/onboarding/{onboarding.module,onboarding.controller,onboarding.dto,onboarding.service}.ts`,
`src/dashboard/{dashboard.module,dashboard.controller,dashboard.service}.ts`,
`src/auth/{phone.controller,phone-verification.service,session-delivery}.ts`,
`prisma/migrations/20261105124743_phase2_onboarding_billing/`, `prisma/migrations/20261105124800_phase2_integrity/`,
`prisma/seed-demo.ts`, `test/phase2.e2e-spec.ts`, `test/support.ts`.

**Changed (API):** `prisma/schema.prisma`, `prisma/seed.ts`, `src/app.module.ts` (modules + `SubscriptionGuard`),
`src/config/env.ts` (`S3_*`, `JOBS_ENABLED`), `src/common/auth/{guards,decorators}.ts`,
`src/auth/{auth-mailer,auth.controller,auth.module,auth.service,dto}.ts`, `src/prisma/{prisma.service,tenant-scope.extension}.ts`,
`test/{env,global-setup}.js`, `package.json` (bullmq, AWS SDK, `seed:demo`), and `test/phase1.e2e-spec.ts`.
In the Phase 1 spec, only its local mailer class was replaced by the shared one in `test/support.ts`, because the
mailer port gained two methods. **No Phase 1 assertion changed.**

**New (web):** everything under `apps/web/` (config, `src/app/**`, `src/components/**`, `src/lib/**`, tests).

**Other:** `infra/minio/public-logos-policy.json`; `docker-compose.yml` (minio-init applies that policy so only
`tenants/*/logos/*` is anonymously readable); root `package.json` (web scripts); `.gitignore`; `CLAUDE.md`,
`README.md`, `docs/ARCHITECTURE.md`.

## Blocked or incomplete

1. **MinIO wasn't available on the build machine.** There was no Docker, and downloading the MinIO binary was blocked
   by this session's permission policy. The 3 storage e2e tests therefore failed with "connection refused", and the
   `minio-init` policy line is untested. Action: run the e2e suite with docker-compose's MinIO. They should pass; if
   not, that's the first thing to fix.
2. **SMS / email delivery (Veltrix, Phase 8):**
   - In production, phone OTP returns 503 and the checklist shows "SMS verification opens soon".
   - Invitation, verification, reset and billing emails are logged in development and not sent in production.
3. **Subscription payment collection (Phase 5):**
   - Invoices are created and tracked, but nobody can pay them yet, so a trial that ends will expire after the 3-day
     grace period.
   - **Decide before launch:** either ship Phase 5 first, or extend `billing.grace_days` / trial lengths so early
     sellers aren't locked out of writes.
   - Payment retries (§14) are wired as a hook point in the lifecycle and come with the Paystack adapter.
4. **Production storage for public logos:** the dev bucket policy exposes only the logos prefix. On Cloudflare R2, a
   public bucket domain exposes the *whole* bucket, so use a separate public bucket or a CDN rule limited to
   `tenants/*/logos/*`, and set `S3_PUBLIC_BASE_URL`. Without `S3_PUBLIC_BASE_URL`, logos are served via 1-hour
   presigned URLs, which works but isn't cacheable.
5. **Legal text needs counsel's review** (see *Phase 2 additions*). The Terms commit Phase 5–7 to two commission
   behaviours: deduction at settlement or a monthly invoice, and no commission on refunded amounts.
6. **Company identity** in the legal pages comes from `NEXT_PUBLIC_LEGAL_*` env vars. Until they are set, the pages
   show "LiveSell Africa" and point to the contact form.
7. **No admin UI yet:** plan editing and verification review are API-only (Swagger) until the admin portal (Phase 11).
8. **Minor:**
   - The e2e Jest process takes a few seconds to exit after the run (it's a pre-existing warning, not a hang;
     `--detectOpenHandles` reports nothing).
   - BullMQ warns on Redis < 6.2 (the build machine had 5.0.14; docker-compose uses Redis 7).
   - The web app has no Dockerfile or Nginx route yet.
   - The reporting time zone is fixed to Africa/Lagos; per-tenant zones come with other countries.

## Needed from you

- Run the e2e suite once with docker-compose (MinIO, Redis 7, Postgres 16) and confirm 58/58.
- Confirm the commission option's placeholders: the rate (3%) and its limits (100 products, unlimited orders, 2 seats).
- Decide on point 3 (grace period vs. Phase 5 timing).
- Legal review of `apps/web/src/content/legal.ts`, plus the registered company name, address and support/privacy
  emails.
- Still outstanding from Phase 1: Veltrix docs and credentials, a Bachs sandbox, Paystack/Flutterwave test keys.

## Phase 2 additions (second iteration)

### Commission-based or subscription-based sellers
- **Model.** `subscription_plans.pricing_model` is `SUBSCRIPTION` or `COMMISSION`, plus `commission_bps`.
  - A DB CHECK enforces the rules: commission plans have a rate between 0 and 10,000 bps and ₦0 fixed prices;
    subscription plans have no rate.
  - The admin API validates the same rules. It refuses to change a plan's pricing model while sellers are on it, and
    audits rate changes.
- **Seeded option:** "Pay as you sell" (`PAY_AS_YOU_SELL`): ₦0/month, **3% per verified sale (placeholder)**,
  100 products, unlimited orders, 2 seats.
- **Choosing.**
  - At sign-up: a "How would you like to pay LiveSell?" choice. Every store still starts with the free trial; the
    choice is applied as a free trial switch.
  - Later: Plan & billing.
  - Commission plans are always monthly.
- **Switching.**
  - Commission → subscription is an upgrade: a prorated invoice, applied when it is paid.
  - Subscription → commission waits for the end of the paid period.
  - An expired store can restart on commission immediately, because nothing is due.
- **Lifecycle.** Zero-fee plans roll into the next period with **no invoice and no overdue notice**; a `RENEWED`
  event is recorded. Trial-ending reminders still go out; zero-fee renewal reminders don't.
- **Rate resolution.** `CommissionService.effectiveRate(tenantId, provider?)`, the input for Phase 5. Precedence:
  1. Trial → 0.
  2. A negotiated per-seller override (`seller_payment_accounts.commission_bps`).
  3. The commission plan's rate.
  4. `commission.default_bps` for subscription sellers (0).

  `commissionFor(gross, bps)` computes the amount in BigInt kobo, rounded down.
- **Shown** on the pricing page (a separate commission card), at registration, and in Plan & billing (which commission
  applies right now, and why).

### Legal text
- `/terms` and `/privacy` now carry full documents written for Nigerian law: NDPA 2023, NDPC, FCCPA 2018, NAFDAC,
  and the Arbitration and Mediation Act 2023 with arbitration seated in Lagos. They describe the real system: both
  pricing options, trial, grace period, read-only on non-payment, verified-payment rule, controller/processor split
  for customer data, the single essential cookie, retention and security measures.
- Each document is versioned (`2026-11-05`). Registration stores `tenants.terms_version` / `privacy_version` and
  records them in the audit log.
- Invited staff must now accept the terms; that acceptance is audited.
- **Not legal advice.** Have counsel review `apps/web/src/content/legal.ts` before launch. Company name, address and
  emails come from `NEXT_PUBLIC_LEGAL_*`; nothing about the entity is invented.

### Sales contact
- `/contact` form → `POST /api/v1/sales-inquiries` (public). The form has client- and server-side validation. A hidden
  honeypot field makes bot submissions silently dropped.
- Rate limit: 5 per IP per hour (`SALES_INQUIRY_LIMIT`).
- Enquiries are stored in `sales_inquiries` (platform data). Admins and support handle them via
  `GET/PATCH /api/v1/admin/sales-inquiries`, and updates are audited.
- New enquiries go through a `SalesNotifier` port. It logs company names only; the email adapter comes with Veltrix.
- Linked from Enterprise / custom plans on the pricing and billing pages, and from the footer. This replaces
  `NEXT_PUBLIC_SALES_EMAIL`.

### Migrations
`20261105134525_phase2b_pricing_models_sales` (generated) and `20261105134600_phase2b_integrity` (CHECKs). The drift
check is empty.

### Tests added
- **Unit:** commission maths and rounding; pricing-model validation.
- **E2E:**
  - The commission plan is public.
  - Legal versions are recorded at registration.
  - Commission lifecycle: trial at 0% → active with no invoice → monthly renewal without charge.
  - Commission ↔ subscription switching.
  - An expired store restarts on commission.
  - Override precedence.
  - Admin validation, including the model-change lock.
  - Sales enquiry storage and admin handling.
  - Validation and honeypot.
  - Terms required on invite sign-up.
- **Web:** basis-points formatting.

### E2E run — 58 / 58
- MinIO couldn't run on the build machine: no working Docker hypervisor, and MinIO no longer publishes Windows
  binaries (`dl.min.io` returns 410).
- So the storage tests ran against a private **AWS S3** test bucket instead, which is closer to production anyway.
  It used a key restricted to that one bucket.
- **All 58 pass.** The real-S3 run covered presigned PUTs with signed size and type, rejection of a size or type
  mismatch, deletion of a disguised file, single-use confirmation, the tenant-bound check on keys, private documents
  returning 403 without a signature, and presigned reads for admins.
- How to repeat it: copy `apps/api/test/.env.s3.example` to `apps/api/test/.env.s3` (gitignored) and fill in a bucket
  and key. Without that file the suite uses local MinIO as before.
- Still unverified: docker-compose's `minio-init` bucket policy. Also, because MinIO stopped publishing binaries,
  pin the `minio/minio` image to a release tag before relying on it.
