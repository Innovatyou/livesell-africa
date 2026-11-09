# Phase 5 report — payment abstraction and Paystack

Scope: MASTER-SPEC §28 Phase 5, which covers §12 (payment provider abstraction and Paystack) and the §26 payment
scenarios #3, #4, #11 and #12. It also turns on online payment for orders and for LiveSell's own subscription
invoices.

## Status at a glance

| Check | Result |
|---|---|
| API unit tests | **56 / 56** (41 earlier + 15 new: adapter mapping, ledger recipes) |
| API e2e (real Postgres + Redis + S3 test bucket) | **127 / 127**: 99 earlier + **23 payments** + **5 real Paystack sandbox calls** |
| Web tests (Vitest) | **18 / 18** |
| `tsc --noEmit`, `nest build`, `next build` | clean |
| Drift check after the new migrations | empty |
| Live smoke test (running API, dev database, real Paystack test API) | seller key validated and stored encrypted (a bogus key got 422) → real `checkout.paystack.com` link for demo order LS-DQ56QV → server-side verify said "abandoned" → order stayed unpaid; bank list loaded (296 banks); webhook ignored while switched off; no key in logs, responses or audit |

## Needs your confirmation

1. **Webhook signature.**
   - I couldn't read Paystack's webhook page (paystack.com returns 403 to automated fetches), and the official OpenAPI
     spec doesn't describe signatures.
   - The adapter implements the scheme as I understand it: header `x-paystack-signature` carries an HMAC-SHA512 of the
     raw body, keyed with the secret key. It is unit-tested, but it is **not confirmed against Paystack's docs**.
   - Webhook processing is therefore **off** (`PAYSTACK_WEBHOOKS_ENABLED=false`). Payments don't depend on it:
     the customer's return, "Check payment" and the 10-minute reconciliation job all confirm payments by asking
     Paystack directly.
   - Please check https://paystack.com/docs/payments/webhooks. If it matches, set the flag to `true` on a server
     Paystack can reach and register these URLs in the dashboard:
     - platform: `…/api/v1/payments/paystack/webhook`;
     - each direct seller: the URL shown in their Settings → Payments.
2. **One completed test payment.**
   - The sandbox tests cover key validation, start payment, verify an unpaid payment, a duplicate reference, an unknown
     reference, refusal of a refund on an unpaid payment, and the bank list.
   - What I can't do without a browser is pay with a test card. Doing so would confirm the "paid" path end to end and
     the refund status names (I map `processed` to completed).
   - To try it: run the app, open a demo order that is awaiting payment, click **Create payment link**, pay with one of
     Paystack's test cards, then refund it from the same page.
3. **Collecting commission from sellers on direct settlement.**
   - With split settlement, Paystack takes LiveSell's commission automatically.
   - With a seller's **own** Paystack account, the commission is recorded as owed to LiveSell (ledger:
     `COMMISSION_PAYABLE` / `COMMISSION_RECEIVABLE`) but **nothing collects it yet**.
   - Options:
     - (a) require split settlement on the commission ("Pay as you sell") plan; or
     - (b) add the month's commission to the seller's LiveSell invoice.
   - I recommend (a) for launch. Which do you want?
4. **Refunds on split payments.**
   - The ledger reverses LiveSell's commission in proportion to the refund.
   - Paystack's own rule for which balance a split refund is taken from isn't in the spec, so please confirm it on the
     dashboard before going live with split refunds.
5. **Still open from Phase 4:** pull manual bank-transfer verification forward from Phase 7, or keep it there? I've
   kept it in Phase 7.
6. **Rotate the Paystack test keys.** They were pasted into this chat. They're stored only in the gitignored
   `apps/api/.env`.

## What was built

### Provider abstraction (§12)

- **Provider port.**
  - `src/payments/payment-provider.ts` defines the port: validate credentials, start a payment, verify a payment,
    parse a webhook, refund and check a refund, create a subaccount, resolve an account and list banks.
  - Credentials are passed on each call, because a payment uses either the seller's key or the platform key.
- **`PaystackAdapter`.**
  - It is the only code that talks to Paystack: plain `fetch` with a 15 s timeout.
  - Field names come from Paystack's official OpenAPI spec, and responses were checked against the sandbox.
  - Network errors, timeouts, 5xx and 429 responses become "provider unavailable" (§26 #11).
- **`PaymentProviderRegistry`.**
  - Maps provider codes to adapters.
  - A provider is usable only when a platform admin has enabled it (`GET/PATCH /admin/payment-providers`).
  - Providers without an adapter (Flutterwave, Bachs) can't be switched on. The tests replace the registry with a
    scriptable fake.

### How sellers get paid

- **Own Paystack account (direct).**
  - The seller pastes their secret and public keys. The secret key is checked with Paystack, then stored with
    `CryptoService.encrypt(key, tenantId)` (bound to that store).
  - The key is never returned or logged. Test and live keys can't be mixed.
- **Through LiveSell (split).**
  - The seller picks a bank and enters a 10-digit account number.
  - The account name is confirmed with the bank, and a Paystack subaccount is created.
  - The account number is stored encrypted and only the last four digits are shown.
  - On each payment, LiveSell's commission is sent to Paystack as a flat platform charge; the seller's share bears
    Paystack's fee.
- **Commission.**
  - Fixed when the payment starts, via `CommissionService.effectiveRate()`.
  - Zero during the free trial, the plan rate on "Pay as you sell", otherwise the platform default (0).
- **Settings → Payments** shows:
  - connection status;
  - test-mode badge;
  - on/off switch;
  - commission;
  - webhook URL (direct only);
  - recent payments with fee, commission and "you receive".

### Taking a payment

- **Ways to start a payment.**
  - **Storefront:** the tracking page shows **Pay now** (email for the receipt → Paystack). The private tracking token
    is required.
  - **Staff:** **Create payment link** on the order page, with Copy and **Send on WhatsApp**. This needs
    `orders:create`, so live moderators can send links too.
  - **Billing:** **Pay now** on open LiveSell invoices, paid through the platform account.
- **Link reuse.** An unpaid link is reused for 30 minutes instead of creating a second charge.
- **Stock hold.** Stock stays held for at least 30 minutes once the customer goes to pay.
- **Return page.** After Paystack, customers land on `/payments/return`. The page asks our server, which asks Paystack.
  It keeps checking briefly for slow transfers/USSD and never claims success on its own.
- **Recognising money (rule 4).**
  - All four paths end in one function: the customer's return, webhook, staff "Check payment" and the reconciliation
    job.
  - That function trusts only Paystack's verify answer and requires the **exact amount and currency**.
  - In one database transaction, with the payment row locked, it:
    - records the result;
    - posts balanced ledger journals;
    - marks the order paid (or applies the invoice).
  - Repeating any path changes nothing.
- **Edge cases.**
  - **Short or wrong-currency payment:** recorded as failed ("amount did not match"), never applied, audited.
  - **Payment after the hold expired, or a second payment on a paid order:** recorded (the money arrived), **not**
    applied. The order stays cancelled or paid, and the payment is flagged "Refund the customer" with a note in the
    order activity.
  - **Paystack down:** nothing is charged or changed; the customer sees "try again in a few minutes"; the return page
    says "don't pay twice".

### Refunds (§26 #12)

- **Requesting.** `POST /orders/:id/refunds` with `payments:refund`; a dialog on the order page, full or partial.
- **Safeguards.**
  - An `Idempotency-Key` header (one key per dialog) makes double-clicks and retries safe.
  - The amount already being refunded counts against what can still be refunded; failed attempts free it again.
- **Completion.**
  - The ledger reversal and the order's **Refunded / Partly refunded** status are applied only when Paystack reports
    the refund complete, via the reconciliation job or a webhook.
  - Commission is reversed in proportion, and exactly in full on the last refund.
- **Stock.** A full refund of goods that haven't been dispatched releases their reserved stock. Refunds of dispatched
  goods leave stock as sold; returns come with logistics in Phase 10.
- **Allowed while lapsed.** Refunds work even when the seller's subscription has lapsed.

### Webhooks (§26 #3)

- **Routes:** platform `/payments/paystack/webhook` and per seller `/payments/paystack/webhook/:accountId`.
- **Checks.**
  - Raw bodies are kept for webhook routes only.
  - Each event is checked with the key of the account it claims to come from.
  - It is ignored if the payment belongs to a different account.
  - Events are de-duplicated on (provider, event id).
- **The body is never trusted for money.** A webhook only triggers a verify call. The tests prove that a webhook
  claiming success doesn't mark an order paid while Paystack's verify says otherwise.

### Ledger

`src/ledger/ledger.service.ts` defines the chart of accounts and pure journal recipes, and posts them inside the
caller's transaction. Seller and LiveSell books are separate journals, each balanced on its own. A database trigger
rejects unbalanced journals; entries can't be edited or deleted.

| Event | Seller books | LiveSell books |
|---|---|---|
| Sale, direct settlement | gateway clearing (gross − fee), Paystack fee, sales revenue; commission expense against commission payable | commission receivable against commission revenue |
| Sale, split settlement | gateway clearing (gross − commission − fee), Paystack fee, commission expense, sales revenue | gateway clearing against commission revenue |
| Refund | refunds against gateway clearing; proportional commission reversal | proportional commission reversal |
| Subscription | — | gateway clearing, Paystack fee, subscription revenue |

### Reconciliation job

- Runs every 10 minutes (BullMQ).
- Re-verifies payments still open for up to 48 hours, then marks them abandoned.
- Settles refunds that are still processing.
- Stops early if Paystack is down.

## Schema changes

- `20261106120000_phase5_payments`:
  - `seller_payment_accounts`: test mode, settlement bank account, last verified;
  - `payment_transactions`: which seller account took the payment, failure reason.
- `20261106120100_phase5_integrity`:
  - one LiveSell ledger account per code and currency (`tenant_id` is NULL there);
  - `proceeds + commission + fee = gross` on transactions;
  - currency format on refunds;
  - **no deletes** on transactions, refunds and webhook events.
- `20261106120200_phase5_invoice_link`: `payment_transactions.subscription_invoice_id`, plus indexes for the
  reconciliation job.

## Tests added

- **Unit (adapter, mocked `fetch`):**
  - request fields in kobo, plus split fields;
  - verify mapping;
  - unknown reference;
  - duplicate reference;
  - unavailability (network, timeout, 5xx, 429);
  - key validation;
  - refund fields and statuses;
  - webhook signature (valid, missing, wrong key, tampered body).
- **Unit (ledger):** unbalanced journals refused; direct and split sales balance and net correctly; proportional
  commission reversal adds up exactly; refund and subscription journals.
- **E2E (`test/phase5.e2e-spec.ts`, fake provider, 23 tests):**
  - **Settings.**
    - Key checked and encrypted, never in responses or audit, bound to the tenant.
    - Split: account resolution and encrypted account number.
    - On/off.
    - Admin provider control; unknown or not-integrated providers refused.
    - Permissions per role.
  - **Payment.**
    - Full storefront flow, plus the guards along the way:
      - email required;
      - wrong token gives 404;
      - link reuse;
      - return-without-payment isn't paid.
    - Then PAID with exact ledger and fee/proceeds. Idempotent across all four paths.
  - **Staff link and reconciliation job.**
  - **Edge cases:**
    - short and wrong-currency payments refused;
    - **§26 #4** failed then retried;
    - **§26 #11** Paystack down at start and at verify;
    - hold kept alive while paying;
    - **§26 #2** payment after expiry flagged and refunded without reviving the order;
    - duplicate payment flagged.
  - **Commission.** Split on the commission plan:
    - platform charge sent to Paystack, both books balanced;
    - half then full refund reverses commission to exactly zero;
    - no commission in trial.
  - **§26 #12 refunds:**
    - partial then full;
    - idempotency key;
    - amount in flight counted;
    - stock released only for undispatched goods;
    - provider decline and outage;
    - provider-failed refund changes nothing;
    - nothing to refund on an unpaid order.
  - **§26 #3 webhooks:**
    - body not trusted;
    - duplicate ignored;
    - forged, unsigned or wrong-route signatures refused;
    - another account's payment ignored;
    - platform webhook settles split payments and refunds.
  - **Subscriptions:** invoice paid through the platform key; the plan applies only after verification; only LiveSell's
    books touched.
  - **§26 #9:** another seller can't create links, verify, refund, list or pay this seller's orders.
  - **Database:** refuses unbalanced journals, edits to posted entries, deleting transactions, and incoherent splits.
- **Sandbox (`test/paystack-sandbox.e2e-spec.ts`, real Paystack test API, 5 tests):**
  - key accepted, bogus key rejected;
  - start + verify-as-unpaid + duplicate reference refused;
  - unknown reference;
  - refund of an unpaid payment declined;
  - bank list.
  - It uses the test key from `apps/api/.env`, skips without one, and refuses live keys.
- **Web:** refundable-amount maths and status labels.

## Files

**New (API):**
- `src/payments/{paystack.adapter,provider-registry,payments.service,payments.controller,payments.dto,payments.jobs,payments.module,paystack.adapter.spec}.ts`
- `src/ledger/{ledger.service,ledger.spec}.ts`
- the three migrations above
- `test/{phase5,paystack-sandbox}.e2e-spec.ts`

**Changed (API):**
- `src/payments/payment-provider.ts`: the real port.
- `src/billing/{subscriptions.service,billing.controller,billing.module}.ts`: invoice payment moved to payments;
  `applyPaidInvoiceTx` is now public.
- `src/orders/orders.service.ts`: `isPayableTx`, `noteTx`, `applyRefundTx`; fees and refunds in order detail.
- `src/storefront/{storefront.controller,storefront-checkout.service,storefront.module}.ts`: Pay now, and
  `onlinePayment` in tracking.
- `src/configure-app.ts` (raw body for webhooks), `src/config/env.ts`, `src/app.module.ts`, `prisma/schema.prisma`,
  `.env.example`.
- `test/{env.js,support.ts}`: fake provider; placeholder platform key.

**New (web):**
- `src/app/(app)/settings/payments/page.tsx`
- `src/app/payments/return/page.tsx`
- `src/components/{order-payments,payment-return}.tsx`
- `src/lib/{payment-labels,payment-labels.test}.ts`

**Changed (web):**
- `src/app/(app)/orders/[id]/page.tsx`: payments card replaces the "coming soon" notice.
- `src/app/(app)/settings/billing/page.tsx`: Pay now.
- `src/components/store/order-tracking.tsx`: Pay now.
- `src/components/app-shell.tsx`: Payments in the navigation.
- `src/lib/{types,api}.ts`: `api()` accepts extra headers, for `Idempotency-Key`.

**Docs:** `README.md` (endpoints), `docs/ARCHITECTURE.md` (payments section), `CLAUDE.md` (status and payment rules).

## Blocked or incomplete

1. **Webhooks are off** until the signature scheme is confirmed (see above). They also need a public URL, so they can't
   work against localhost anyway.
2. **The "paid" path and refund statuses against real Paystack** are covered by the fake provider, not yet by a real
   test-card payment (see above).
3. **Commission collection on direct settlement** is recorded but not collected (decision above).
4. **Automatic renewal charging** (saved card authorisations) isn't built. Owners pay each LiveSell invoice with a
   Paystack link, and the existing reminders and grace period apply.
5. **Settlement tracking:** payments are marked "settlement pending". Matching Paystack's settlement payouts
   (the `settlements` table) and payout reports come later with the payouts/reporting work.
6. **Flutterwave and Bachs** come in Phase 6, and **bank-transfer verification** in Phase 7. Bachs still needs docs
   and credentials.
7. **Still open from earlier phases:**
   - commission rate and limits (3% "Pay as you sell" is a placeholder);
   - legal review and company details for the legal pages;
   - trial/grace timing;
   - the unverified local MinIO setup.
8. **Dev data changed by the smoke test.** In the dev database, Paystack is enabled and the demo seller is connected
   with your test key (direct), with one abandoned test payment on LS-DQ56QV. Payment rows can't be deleted, by
   design. To start clean, reset the dev database and run `npm run seed && npm run seed:demo`.

## Needed from you

- Confirm or correct the webhook signature details (item 1 above).
- Optionally, complete one test-card payment and refund from the order page.
- Decide commission collection for direct settlement: (a) split required on the commission plan, or (b) invoice it.
- Decide the Phase 4 question on manual bank-transfer verification.
- Go-ahead for Phase 6 (Flutterwave and Bachs adapters). Flutterwave needs test keys; Bachs needs docs and credentials.
