# Phase 7 report — direct bank transfer and reconciliation

Scope: MASTER-SPEC §28 Phase 7, covering §13 (direct bank transfer), §12 "Payment reconciliation" and §26 #5 ("bank
transfer remains unverified"). This is also the manual transfer verification asked about in Phase 4.

## Status at a glance

| Check | Result |
|---|---|
| API unit tests | **75 / 75** (74 earlier + bank-transfer ledger entries) |
| API e2e (real Postgres + Redis + AWS S3 test bucket) | **159 / 159**: 148 earlier + **11 Phase 7** |
| Web tests (Vitest) | **20 / 20** |
| `tsc --noEmit`, `nest build`, `next build` | clean |
| Drift check after the new migration | empty |
| Live smoke test (running API, dev database) | the demo store's transfer account shows on a new customer order → customer reports the transfer → order "verifying payment" → wrong amount refused → correct amount verified → order **PAID**; customer sees "Confirmed by the seller"; reconciliation of the demo store: 0 errors, 0 warnings; changed pages return 200 |

## Needs your attention

1. **Hold time for unverified transfers.**
   - Once a customer reports a transfer, their items stay reserved for **72 hours**
     (platform setting `orders.transfer_hold_hours`).
   - A report still unchecked after **24 hours** shows as a warning (`payments.transfer_stale_hours`).
   - Both are placeholders; tell me if you want different values.
2. **Account-name check.**
   - When LiveSell's Paystack or Flutterwave key is set, the seller's account name is confirmed with the bank and
     shown as "Name confirmed".
   - In Paystack's **test** mode most real accounts don't resolve, so in development names usually show
     "Name not confirmed". Live keys resolve normally.
3. **Virtual accounts aren't built.** §13 lists a "provider-supported virtual account" as optional, with automatic
   reconciliation where a provider notifies us of transfers. Each provider (Paystack dedicated accounts, Flutterwave
   or Bachs virtual accounts) needs business approval, and usually customer BVN details. If you want this, tell me
   which provider you have approval with.
4. **Uploads in local development.** The dev `.env` points uploads at MinIO, which can't run here (Docker's
   hypervisor is off). Receipt uploads are covered by the e2e tests against the AWS test bucket. To use them in dev,
   point the dev `S3_*` variables at the same test bucket, or start MinIO.
5. **Still open:**
   - **Bachs:** a key with `refunds:write`, and the `connect` capability for split settlement.
   - **Webhooks:** secrets for Flutterwave and Bachs, and confirmation of Paystack's signature scheme.
   - **Commission on sellers' own accounts:** how to collect it. This now includes bank transfers, where it's recorded
     as owed but not collected.
   - **Key rotation:** rotate the provider test keys that were shared in chat.

## What was built

### Seller's transfer accounts (§13)

- **What a seller sets per account:**
  - bank (chosen from the bank list) or typed name;
  - 10-digit account number;
  - account name;
  - instructions for customers;
  - up to three accounts, one shown first.
- **Name confirmation.** The name is confirmed with the bank when a provider allows it. If the bank's name differs
  from what was typed, the seller is told and the bank's name is used.
- **Storage.** Account numbers are encrypted at rest with the store-bound key. They are shown to customers in full,
  since that is what the account is for.
- **Kept separate from settlement.** Split-settlement bank accounts from Phases 5 and 6 are never shown to customers.

### Customer reports a transfer

- **What the customer sees.** Account details with copy buttons, the amount, and "put LS-XXXXXX in the transfer
  description".
- **"I've sent the money" form.**
  - Name on the paying account; their bank and transfer reference (optional).
  - An optional receipt: photo or PDF, up to 5 MB, uploaded straight to private storage. Its type is checked from the
    file's first bytes, and an upload can only be used once.
- **What a report does.**
  - It creates an **unverified** bank-transfer payment record.
  - It moves the order to "verifying payment" and keeps the stock reserved.
  - The customer's page says plainly that the seller still has to check their bank.
- **Limits.** Rate-limited, with a honeypot; the private tracking token is required; at most three pending reports
  per order.
- **Staff reports.** Staff (`orders:create`, including live moderators) can record a transfer a customer mentioned on
  WhatsApp, with a receipt.

### Verification (rule 4)

- **Who can verify.** Only people with `payments:verify_transfer`: owner and store manager.
- **What they confirm.**
  - "Money received": they enter the amount they see in their bank, which must equal the order total, and tick
    "I have seen this money in my bank account (not only a receipt)".
  - "Not in my account": rejects with a reason.
- **On verify,** in one database transaction with the payment row locked:
  - the payment is recorded as verified, with who did it;
  - balanced ledger entries are posted: the sale lands in a new **seller bank** account, plus commission owed on a
    commission plan;
  - the order becomes **PAID** through the same hook online payments use.
- **Repeats and audit.** Verifying twice is refused, and every decision is audited.
- **On reject:** the customer sees "the seller could not find this transfer" and can report again. The order goes
  back to "awaiting payment" when no other report is pending.
- **Receipts** open through a short-lived private link (`payments:read`). The page says a receipt alone is not proof.

### §26 #5: a transfer that stays unverified

- Reported transfers are listed under **Settings → Payments → Transfers to check**, oldest first, and shown on the
  order as "Transfer to check".
- If nobody checks before the hold ends, the order is cancelled and its stock goes back on sale. The report stays
  flagged ("Transfer on a cancelled order").
- If the money did arrive, the seller can still verify it. It is recorded, **not** applied to the cancelled order,
  and flagged "refund the customer".

### Refunds of bank transfers

- LiveSell can't send the money, so the seller refunds from their own bank and **records** it, with a required
  description such as "Transfer from GTBank, ref 000123".
- The ledger reversal and the order status (partly or fully refunded, with undispatched stock released) apply at once.
- Online-provider refunds work as before.

### Reconciliation (§12)

A read-only report under **Settings → Payments → Reconciliation**. It checks that:

1. every verified payment has its sale in the books for the exact amount;
2. completed refunds match the refund entries;
3. no order shows as paid without a verified payment behind it;
4. money received for cancelled or already-paid orders has been refunded;
5. reported transfers get checked in time, and none sit on cancelled orders;
6. provider refunds complete within a week.

Each issue links to its order. Platform admins get a per-store summary (`GET /admin/payments/reconciliation`), and a
daily job (02:30 Lagos time) records which stores have issues in the audit log. Demo-seed rows (development only,
created before the ledger existed) are excluded from the books check.

## Schema changes

- `20261106170000_phase7_bank_transfers`:
  - `bank_accounts.for_transfers`, `is_active` and `name_verified`, plus an index;
  - a database rule allowing **one default transfer account per store**;
  - a database rule that **a bank-transfer payment must carry its transfer report**.

  The last rule is added as `NOT VALID`: it applies to every new or changed row. 68 older demo-seed rows in the dev
  database predate it; the demo seed now writes the report too.
- New platform settings (defaults only): `orders.transfer_hold_hours` = 72, `payments.transfer_stale_hours` = 24.
- The migration first failed on the dev database because of those 68 demo rows. I removed the half-applied columns,
  changed the rule to `NOT VALID` and applied it cleanly. It had never been applied anywhere else.

## Tests added

- **Unit:** bank-transfer sale and refund journals (seller bank, no gateway fee, commission owed).
- **E2E (`test/phase7.e2e-spec.ts`, 11 tests):**
  - **Accounts:**
    - name confirmed and replaced by the bank's;
    - number encrypted;
    - one default;
    - limit of three;
    - validation;
    - role permissions;
    - another store's account is 404.
  - **Customer report:**
    - tracking shows the account;
    - receipt uploaded to the real S3 test bucket under the private prefix;
    - wrong token or SVG refused;
    - order to "verifying payment" with a 72 h hold and stock still reserved;
    - no internal fields on the customer page;
    - an upload can't be reused;
    - nothing paid and nothing in the books.
  - **Refusals:** bots, wrong tokens, invented keys, too many reports, store without an account, another store's order.
  - **Verification:**
    - sales assistant and non-member refused;
    - another store 404 (**§26 #9**);
    - wrong amount refused;
    - PAID with seller-bank ledger entries, verifier recorded, audited;
    - second verify refused;
    - fulfilment continues;
    - reconciliation clean.
  - **Reject:** back to awaiting payment only when no other report is pending; the customer sees "not found".
  - **Staff:** staff-recorded transfer with a PDF receipt; receipt link private (`payments:read`) and loads; pending
    list; order detail.
  - **Commission plan:** commission booked for both sides.
  - **§26 #5:**
    - warning after 24 h;
    - hold ends → cancelled and stock freed → "transfer on a cancelled order";
    - late verification flagged for refund;
    - recorded refund (details required, no provider call) → books and reconciliation clean.
  - **Recorded refunds on a paid order:** partly then fully refunded, stock released.
  - **Reconciliation:** paid order without a payment; payment without books; scoped to the store; admin summary;
    permissions.
  - **Database:** a bank-transfer payment without its report is refused.
- **Web:** transfer status labels.

## Files

**New (API):**
- `src/payments/{bank-transfer.service,bank-transfer.controller,reconciliation.service}.ts`
- the migration above
- `test/phase7.e2e-spec.ts`

**Changed (API):**
- `src/payments/payments.service.ts`: recorded refunds for transfers; bank-account name resolution.
- `src/payments/{payments.dto,payments.module,payments.jobs}.ts`: DTOs; daily reconciliation job.
- `src/ledger/ledger.service.ts`: `SELLER_BANK`, bank-transfer recipes.
- `src/orders/orders.service.ts`: `awaitVerificationTx`, `backToPendingTx`; transfer details in order detail.
- `src/storefront/{storefront.controller,storefront-checkout.service}.ts`: transfer details in tracking, report and
  receipt routes.
- `src/storage/upload-policy.ts`: private `transfer-receipt` uploads.
- `prisma/{schema.prisma,seed.ts,seed-demo.ts}`.

**New (web):** `src/components/{bank-transfer-settings,store/transfer-panel}.tsx`.

**Changed (web):**
- `src/components/order-payments.tsx`: transfer reports, verify/reject dialogs, record transfer, recorded refunds.
- `src/components/store/order-tracking.tsx`.
- `src/app/(app)/settings/payments/page.tsx`.
- `src/lib/{types,payment-labels,payment-labels.test}.ts`.

**Docs:** `README.md`, `docs/ARCHITECTURE.md` ("Bank transfer and reconciliation"), `CLAUDE.md` status.

## Blocked or incomplete

1. **Virtual accounts with automatic transfer matching:** need provider approval (see above).
2. **Commission on bank transfers** is booked as owed by the seller but not collected (same open decision as for
   sellers' own online accounts).
3. **Customer notifications** ("transfer received", "transfer not found") arrive with Veltrix in Phases 8–9. Until
   then customers see the status on their order page.
4. **Uploads in local development** need MinIO or the S3 test bucket (see above).
5. **Dev data from the smoke tests:**
   - the demo store has a transfer account (GTBank 0123456789);
   - one verified transfer order, LS-WW33CD;
   - one unpaid checkout, LS-ZYYXQY, whose 24 h hold will cancel it automatically.

## Needed from you

- Confirm or change the 72 h hold and the 24 h "unchecked" warning.
- Decide how commission is collected from sellers on their own accounts and bank transfers.
- Say whether you want virtual accounts, and with which provider.
- The open provider items from Phases 5 and 6.
- Go-ahead for Phase 8 (Veltrix API integration). It needs Veltrix API docs and credentials.
