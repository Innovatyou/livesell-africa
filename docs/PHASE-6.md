# Phase 6 report — Flutterwave and Bachs

Scope: MASTER-SPEC §28 Phase 6. It adds Flutterwave and Bachs behind the payment port built in Phase 5, so a store can
take online payments through Paystack, Flutterwave or Bachs, connect more than one, and choose which one customers
use.

## Status at a glance

| Check | Result |
|---|---|
| API unit tests | **74 / 74**: 56 earlier + 18 new (decimal amounts, Flutterwave and Bachs adapters with mocked `fetch`) |
| API e2e (real Postgres + Redis + S3 test bucket) | **148 / 148**: 127 earlier + **12 Phase 6 flows** + **5 real Flutterwave** + **4 real Bachs** sandbox calls |
| Web tests (Vitest) | **19 / 19** |
| `tsc --noEmit`, `nest build`, `next build` | clean |
| Drift check after the new migration | empty |
| Live smoke test (running API, dev database, real test keys) | Flutterwave and Bachs keys checked with each provider and saved encrypted; a bogus Bachs key got 422; default switched between providers; a real **Flutterwave** hosted link (LS-000273) and a real **Bachs** sandbox checkout (LS-000255) created and verified server-side as "pending", orders still unpaid; Flutterwave bank list loaded (598 banks); platform webhook without its hash got 401; no key in responses or logs |

## Needs your attention

1. **Your Bachs key can't issue refunds.**
   - The sandbox key you sent is missing the `refunds:write` scope; Bachs answers 403.
   - Refunds through Bachs are built to the docs and covered by the fake-provider tests, but they are **not verified
     against Bachs**.
   - Please create a sandbox key with `payments:read`, `payments:write` and `refunds:write` and replace `BACHS_API_KEY`
     in `apps/api/.env`. The sandbox test will then check the real refusal for an unpaid charge.
2. **Bachs split settlement (Connect) is not built.**
   - Bachs only splits a payment through Connect. That needs LiveSell's own Bachs account to hold the `connect`
     capability, plus seller onboarding with identity checks.
   - It also requires a platform fee above zero on every split payment, which doesn't fit free-trial sales.
   - For now Bachs works with the seller's **own Bachs account** only. If you want LiveSell-managed settlement on Bachs,
     request the `connect` capability from Bachs and I'll build the onboarding flow.
3. **Webhook secrets for the platform accounts.**
   - Flutterwave and Bachs webhooks are built to their documented signature schemes, and are on by default.
   - Each needs a secret, and Paystack's flag is still off (Phase 5).
   - **Flutterwave:** set a "secret hash" under Settings → Webhooks and put it in `FLUTTERWAVE_WEBHOOK_HASH`.
   - **Bachs:** create an endpoint in the Developer Portal and put its signing secret in `BACHS_WEBHOOK_SECRET`.
   - Webhooks need a public URL, so they can't be exercised against localhost. Payments don't depend on them: the
     return page, "Check payment" and the 10-minute reconciliation job confirm every payment by asking the provider.
4. **Bachs can't send customers back to a local address.**
   - Bachs refuses `localhost` redirect URLs (also in its sandbox), so in development the customer stays on Bachs's
     confirmation page.
   - With a public `APP_URL` (staging/production), customers return to `/payments/return` as with the other providers.
     Payment confirmation doesn't depend on the redirect.
5. **Rotate the Flutterwave and Bachs test keys.** They were pasted into this chat. They're stored only in the
   gitignored `apps/api/.env`.
6. **Still open from earlier phases:**
   - Paystack webhook signature confirmation;
   - one real test-card payment;
   - how to collect commission from sellers on their own accounts;
   - the Phase 4 bank-transfer question.

## What was built

### Two new adapters behind the same port

- **`FlutterwaveAdapter`**, using Flutterwave v3 hosted checkout ("Standard"):
  - Starts a payment with our reference. Flutterwave doesn't reject a reused reference, which I confirmed, so ours are
    random and unique.
  - Verifies by our reference. An unpaid reference answers "No transaction was found" and is treated as "not yet".
  - Refunds take Flutterwave's transaction id. The minimum is ₦100, and partial and repeated refunds are allowed.
    Refund status is tracked by `flw_ref`.
  - Split: a subaccount is created against the seller's bank account (name confirmed first). On each payment
    LiveSell's commission is sent as a flat charge, and the seller receives the rest minus Flutterwave's fee. This
    follows Flutterwave's worked example; their docs contradict themselves on `flat` vs `flat_subaccount`, and the
    worked example is unambiguous.
  - Webhooks: the `verif-hash` header must equal the secret hash.
  - Used Flutterwave's published test bank accounts.
- **`BachsAdapter`**, plain REST (the official Bachs SDK has no refunds or Connect):
  - The sandbox or live host is chosen from the key.
  - Raw-amount checkout in naira, with our reference used as the reference **and** the idempotency key. A retried
    request returns the same checkout instead of a second one (confirmed in the sandbox).
  - Verifies through the checkout session, using the Bachs checkout id we store when the payment starts.
  - Every documented charge status is mapped. Underpaid, overpaid and "accepted" payments are reported as received, so
    the exact-amount check flags them for the seller instead of marking the order paid.
  - Refunds use the `ch_…` charge id and allow **one refund per payment**. LiveSell enforces that and says so before
    the seller refunds.
  - Webhooks: `X-Bachs-Signature-V2` is checked as documented. Any valid signature is accepted during secret rotation,
    and deliveries older than 5 minutes are refused.
- **Provider capabilities.** Each adapter declares what it supports:
  - split settlement;
  - multiple refunds;
  - minimum refund;
  - where its webhook secret comes from;
  - whether redirects must be public.

  The payments service reads these instead of checking provider names.
- **Exact amounts.** Both new providers use naira, not kobo. `money-decimal.ts` converts without floating point.
  An amount that decides "paid" must be exact to the kobo, so a sub-kobo amount can never match an order; fees may
  round.
- **Unchanged safety rules from Phase 5:**
  - an order is paid only after the provider's server-side answer, with the exact amount and currency;
  - the payment record, the balanced ledger entries and the "paid" status are saved in one database transaction;
  - repeats are no-ops;
  - webhooks only trigger a check;
  - outages change nothing.

### Several providers per store

- A store can connect Paystack, Flutterwave and Bachs, one account each, and pick a **default**. The first one
  connected becomes the default.
- If the platform switches a provider off, payments fall back to the store's next connected provider.
- Each connection is the seller's own account, or "through LiveSell" (split) where the provider supports it
  (Paystack, Flutterwave).
- Credentials are stored encrypted as `{secret key, webhook secret}`, bound to the store, and never returned. Changing
  the API key keeps the saved webhook secret. Paystack accounts saved in Phase 5 keep working unchanged.
- **Settings → Payments** shows one card per provider:
  - status, test-mode badge and on/off switch;
  - "Make default";
  - where to find the keys in each provider's dashboard;
  - the webhook URL and whether a webhook secret is saved;
  - the one-refund note for Bachs;
  - recent payments, now with the provider that took each one.
- Customer-facing text names the actual provider ("Pay now … via Flutterwave"). The order page shows each payment's
  provider and fee, and warns before a Bachs refund that only one refund is possible.
- **Routes.** `/payments/settings/:provider/{direct,split,active,default}` and `/payments/:provider/webhook(/:accountId)`;
  the Phase 5 Paystack URLs are unchanged. The return page also reads Flutterwave's `tx_ref`.

## Schema changes

- `20261106150000_phase6_provider_checkout_id`: `payment_transactions.provider_checkout_id` (Bachs `chk_…`), with an
  index on (provider, checkout id) for webhook lookups.
- No change to money columns. The DB checks (balanced journals, append-only entries, no deletes,
  `proceeds + commission + fee = gross`) apply to every provider.

## Tests added

- **Unit:**
  - **Decimal conversion:** exact parsing, refusal of sub-kobo amounts, rounding for fees, round-trips.
  - **Flutterwave adapter:**
    - request fields in naira, with and without split, and no commission override in a trial;
    - verify mapping;
    - "not found";
    - mismatched reference;
    - sub-kobo amounts;
    - outages;
    - bad key;
    - `verif-hash`;
    - refund by transaction id;
    - refund status by `flw_ref`;
    - subaccount fields.
  - **Bachs adapter:**
    - environment from the key;
    - checkout body and idempotency key;
    - public-only redirects;
    - verification through the checkout session for paid, underpaid, open, expired and not-found;
    - mismatched reference;
    - outage;
    - every charge and refund status;
    - V2 signature (rotation, replay window, tampering, missing secret);
    - refund fields;
    - one-refund conflict.
- **E2E (`test/phase6.e2e-spec.ts`, 12 tests, one fake per provider using the real adapters' key and signature
  rules):**
  - **Settings:**
    - provider list with capabilities;
    - per-provider key checks;
    - encrypted credentials including the webhook secret;
    - key rotation keeps the secret;
    - first account becomes default and "make default" leaves exactly one;
    - permissions.
  - **Split:** Flutterwave subaccount; Bachs refused (503). Provider switched off by the platform → fallback.
  - **Flutterwave:**
    - payment to PAID with a balanced ledger;
    - refund uses Flutterwave's transaction id;
    - ₦100 minimum;
    - several refunds.
  - **Bachs:**
    - the checkout id is stored and used to verify;
    - a declined refund is reported;
    - one refund per payment;
    - a failed refund frees the payment;
    - full refund → REFUNDED.
  - **Flutterwave split on the commission plan:** platform charge sent, LiveSell's and the seller's ledgers both
    balanced. A Phase 5 Paystack account with a bare key still works.
  - **§26 #3 webhooks:**
    - **Flutterwave:**
      - wrong or missing hash refused;
      - seller hash on the platform route refused;
      - body not trusted;
      - duplicates ignored;
      - an account without a saved secret refused;
      - another seller's account can't settle the payment;
      - the platform route settles split payments.
    - **Bachs:**
      - forged and stale deliveries refused;
      - wrong route refused;
      - found by checkout id;
      - duplicate ignored;
      - refund webhook completes the refund.
  - **Admin:** all three adapters with capabilities and key status.
- **Sandbox (real APIs, test keys from `apps/api/.env`; skipped without them; live keys refused):**
  - **Flutterwave (5):**
    - key accepted / bogus rejected;
    - hosted link + unpaid verify;
    - banks + test account resolved + invalid refused;
    - subaccount + split link with and without a platform charge;
    - refund of an unknown transaction refused. This call is retried once because Flutterwave's test environment can
      exceed our 15 s timeout, which is reported as "unavailable".
  - **Bachs (4):**
    - key accepted / bogus rejected;
    - NGN checkout with charge id, idempotent retry;
    - unknown checkout;
    - refund refusal. This currently stops at the missing-scope error; see item 1 above.
- **Web:** provider names.

## Files

**New (API):**
- `src/payments/{flutterwave.adapter,bachs.adapter,money-decimal}.ts` and their `.spec.ts` files
- the migration above
- `test/{phase6,flutterwave-sandbox,bachs-sandbox}.e2e-spec.ts`

**Changed (API):**
- `src/payments/payment-provider.ts`:
  - capabilities;
  - key modes;
  - webhook secret;
  - checkout id;
  - refund input with the provider's reference;
  - public-URL helper.
- `src/payments/paystack.adapter.ts`: port changes; no commission override when the commission is zero.
- `src/payments/payments.service.ts`:
  - several providers;
  - default/fallback route;
  - encrypted JSON credentials;
  - capability checks on refunds;
  - per-provider webhooks;
  - settings per provider.
- `src/payments/{payments.controller,payments.dto,payments.module,provider-registry}.ts`.
- `src/config/env.ts`, `.env.example`, `prisma/schema.prisma`.
- `test/{env.js,support.ts}`: placeholder platform keys; the fake provider supports every code.
- `test/phase5.e2e-spec.ts`: credentials are now encrypted JSON.

**Changed (web):**
- `src/app/(app)/settings/payments/page.tsx`: one card per provider.
- `src/components/{order-payments,payment-return}.tsx`, `src/components/store/order-tracking.tsx`: provider-neutral
  text.
- `src/lib/{types,payment-labels,payment-labels.test}.ts`.

**Docs:** `README.md`, `docs/ARCHITECTURE.md` ("Several providers"), `CLAUDE.md` status.

## Blocked or incomplete

1. **Bachs refunds** are unverified against the real API until the key has `refunds:write` (see above).
2. **Bachs split settlement** (Connect) needs the `connect` capability from Bachs and seller onboarding.
3. **Webhooks** need a public URL and the platform secrets (see above). Paystack's stays off until its signature scheme
   is confirmed.
4. **A real paid test payment** hasn't been made on any provider, because test cards need a browser. To try one:
   - **Flutterwave:** use a test card from its docs, e.g. Mastercard 5531 8866 5214 2950, PIN 3310, OTP 12345.
   - **Bachs:** its sandbox simulates payments.
   - In either case, create a link from a demo order awaiting payment. It confirms the paid path and the refund
     statuses end to end.
5. **The Flutterwave encryption key** isn't used: LiveSell only uses hosted checkout, and the key is for direct card
   charges. It's stored in `.env` only.
6. **LiveSell's own subscription invoices** are still collected only through Paystack (the platform billing account).
7. **Dev data changed by the smoke test:**
   - In the dev database, Flutterwave and Bachs are enabled, and the demo seller is connected to both with your test
     keys.
   - Paystack is back as the default.
   - There are two pending test payments, on LS-000273 and LS-000255.
   - Payment rows can't be deleted, by design. To start clean, reset the dev database and run
     `npm run seed && npm run seed:demo`.

## Needed from you

- A Bachs sandbox key with `refunds:write` (and, if you want split settlement on Bachs, the `connect` capability).
- Webhook secrets for the platform Flutterwave and Bachs accounts once there's a public staging URL.
- The open decisions from Phases 4 and 5:
  - manual bank-transfer verification;
  - commission collection on sellers' own accounts;
  - Paystack webhook confirmation.
- Go-ahead for Phase 7 (direct bank transfer and reconciliation, MASTER-SPEC §28).
