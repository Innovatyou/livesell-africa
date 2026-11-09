# Phase 4 report — order management and live-selling sessions

Scope: MASTER-SPEC §28 Phase 4, covering §11 (orders), §9 (live sessions, manual and product-code ordering) and,
because orders now exist, the §10 storefront checkout and order tracking.

## Status at a glance

| Check | Result |
|---|---|
| API unit tests | **41 / 41** (36 earlier + 5 new) |
| API e2e (real Postgres + Redis + AWS S3 test bucket) | **99 / 99**: 21 + 37 + 25 + **16 new** |
| Web tests (Vitest) | **16 / 16** |
| `tsc --noEmit`, `nest build`, `next build` | clean |
| Drift check after the new migrations | empty |
| Live smoke test | storefront checkout → 24 h stock hold → tracking link → order visible to the seller on the "Online store" channel; all new pages 200 |

## Decision needed: orders can't be marked paid yet

Rule 4 says an order becomes **PAID only after server-side payment verification**. That arrives with Paystack in
Phase 5 and with bank-transfer verification in Phase 7. So in this phase:

- PAID can only be reached through one hook, `OrdersService.markPaid()`, which those phases will call. No HTTP
  endpoint and no person can set it; the tests call the hook to simulate a verified payment.
- Sellers can take, edit, confirm and cancel orders. Fulfilment (processing → dispatched → delivered) works, but
  only on paid orders.
- **Unpaid orders release their stock when their hold runs out.** The hold is 48 h for staff-entered orders and 24 h
  for storefront orders; both are platform settings, and a seller can extend a hold.

Many Nigerian social sellers are paid by bank transfer or cash on delivery today. If you want sellers to record
those payments before Phase 5, I can **pull the manual bank-transfer verification from Phase 7 forward**:
verification by a user with `payments:verify_transfer`, a payment transaction record and a balanced ledger journal.
Tell me which you prefer.

## What was built

### Orders (§11)
- **Entry by staff (manual or during a live).**
  - Items can be given by **product code** (`BAG001`, case-insensitive). If a code has several variants, the API
    answers "which one?" with the list.
  - Customers are picked, or created inline by phone. An existing phone number is reused, and the storefront never
    renames an existing customer.
  - Delivery address can be a saved one or new; it's copied onto the order.
  - Line discounts, an order discount, a delivery fee, the sales channel (default "Manual / phone orders"), notes.
  - Save as draft, or confirm.
- **Prices always come from the database.** That's the live-session price if one is set, else the promo price,
  else the regular price. Clients can't send prices (unknown fields are rejected).
- **Totals** are BigInt kobo, and a database check enforces `total = subtotal − discount + delivery` and
  `line = unit × qty − line discount`.
- **References** like `LS-7K3QXP`: random (so they don't reveal order volume), without characters that are easy to
  confuse, and unique per store.
- **Stock.**
  - Confirming reserves stock in the same transaction, via `InventoryService.reserve()`, row-locked and
    all-or-nothing.
  - Editing an unpaid order releases and re-reserves.
  - Cancelling releases.
  - Dispatched or delivered converts reserved stock into a sale, exactly once (`stock_committed_at`).
  - The order row itself is locked for every change.
- **Status machine** (unit-tested):
  - draft → awaiting payment → (verification) → paid → processing → ready → dispatched → delivered.
  - Fulfilment may skip steps forward but never goes back.
  - PAID, payment verification and refunds can only be set by the system.
  - A paid order can't simply be cancelled; that needs a refund (Phase 5).
- **Permissions per step.**
  - Confirm and edit: `orders:create`.
  - Cancel: `orders:cancel`.
  - Fulfilment steps: `orders:update_status`.
  - So sales assistants can fulfil, and live moderators can record orders but not fulfil them.
- **Holds and expiry (§26 #2).** A BullMQ job every 5 minutes cancels unpaid orders whose hold has expired and
  releases their stock. It's idempotent and logged in the order history as a system action.
- **Plan limit.** The monthly order limit counts confirmed orders in the Africa/Lagos calendar month; drafts are
  free.
- **Activity history.** Every step and every edit is recorded with who (staff name, customer, or system) and an
  optional note, e.g. a courier waybill number. The history can't be edited or deleted (database trigger).
- **Search and filters.** Search covers reference, customer name, phone and product code. Views: awaiting payment,
  to fulfil, delivered, cancelled. Filters: channel, live session, customer, date range. Sorts and pagination.
- **Export.** CSV, requiring `customers:export` because it contains customer contact details, and it's audited.
- **Printable document.** An invoice for unpaid orders and a **receipt only for verified-paid orders**, with the
  store logo and details. The app's sidebar and header are hidden when printing.

### Live selling (§9)
- **Sales channels.** TikTok / Instagram / Facebook / YouTube Live, WhatsApp, Other: create, rename, switch off.
- **Sessions.**
  - Title, channel, schedule, description, "how viewers order" text, products to promote (optional live-only price
    for each), and moderators.
  - Every linked id is checked against the same tenant.
  - Status moves scheduled → live → ended, or scheduled → cancelled. Ended sessions can't be edited, but late orders
    can still be recorded against them.
- **Live console** (`/live/[id]`).
  - Go live / end live, and a quick order form that takes product codes and applies live prices.
  - Products shown with codes, live prices and stock left.
  - The session's orders, and running numbers that refresh every 15 s while live.
- **Sales report.** Built only from real orders:
  - orders: total, paid, awaiting payment, cancelled;
  - paid revenue and the amount awaiting payment;
  - units sold, average order value, unique customers;
  - payment-completion and cancellation shares in basis points;
  - top products, duration.
- **Viewer numbers (rule 10).** Peak viewers are stored only if the seller types in what the platform showed them,
  and are labelled "as you reported". There's no conversion rate and nothing is estimated.

### Storefront checkout and tracking (§10)
- **`POST /store/:slug/checkout`.**
  - Takes the customer, the items (by variant, at most 20 lines and 20 each) and the delivery address.
  - Prices come from the database and stock is reserved straight away.
  - The order is created as awaiting payment on the "Online store" channel.
  - Rate-limited to 10 per IP per hour, with a honeypot field.
  - Short stock returns the item names and how many are left.
  - Unpublished, lapsed and suspended stores return 404.
- **Tracking.**
  - The customer gets a **private tracking link** (`/store/[slug]/order/[reference]?token=…`). Only a hash of the
    random token is stored, and it's kept in their browser too.
  - The page shows status steps, items, totals, the hold time, the seller's payment instructions and a "Message the
    seller on WhatsApp" button that includes the reference.
  - A wrong token, a missing token or another store all return 404.
- **Cart.** Checkout now sits next to the existing WhatsApp option.

## Schema changes
- `20261106080000_phase4_orders_live`: `orders.stock_committed_at`, `orders.tracking_token_hash` (unique),
  `order_items.product_code`.
- `20261106080100_phase4_integrity`:
  - order and line totals must add up;
  - live-session viewer numbers are non-negative and the start/end times make sense;
  - live prices are non-negative;
  - **order history can't be edited or deleted** (trigger).
- `20261106080200_order_item_position`: `order_items.position`, so lines keep their entry order. This found a real
  bug in testing: lines were coming back in random order.
- New platform settings (defaults only): `orders.staff_hold_hours` = 48, `orders.checkout_hold_minutes` = 1440.

## Tests added
- **Unit (order rules):** people can never set paid/verified/refunded; fulfilment only moves forward; payment and
  fulfilment statuses stay in step; kobo totals and impossible discounts; reference format and uniqueness.
- **E2E (`test/phase4.e2e-spec.ts`, 16 tests):**
  - Entry: by code and by variant; inline customer created then reused; totals and address copy; 48 h hold;
    "which variant?"; client prices refused; unavailable and short-stock items.
  - Drafts: no reservation until confirmed; confirmation fails cleanly when stock ran out; edits re-reserve and
    roll back on failure.
  - Lifecycle: paid only via the hook, which is idempotent; no going backwards; the sale is committed once with the
    right movement; cancel releases stock; per-role permissions; append-only history.
  - **§26 #2:** expiry cancels the order, releases stock, keeps holds that were extended, and a late payment can't
    revive the order.
  - Monthly order limit (drafts excluded). Database check on totals.
  - Search, views, sort; export permission and audit.
  - **§26 #9:** another seller can't read, change, extend or reference this seller's orders, variants, customers,
    channels or sessions.
  - Live sessions: live prices; moderator records, assistant fulfils; report figures exact; viewer data
    seller-reported or "not provided", with no conversion rate; edit and cancel rules; links to another tenant's ids
    refused; a switched-off channel can't be used.
  - Checkout: database prices; private token stored hashed; tracking timeline; 404 for a wrong token or another
    store; nothing internal leaked; client price, quantity, honeypot, draft product, other store's variant and
    unpublished store all refused; existing customer reused without renaming.
  - **§26 #7 at checkout:** two buyers, last unit → one order and one clear "sold out".
- **Web:** order status labels and actions, hold countdown.

## Files
**New (API):** `src/orders/{orders.module,orders.controller,orders.service,orders.dto,orders.jobs,order-rules,order-rules.spec}.ts`,
`src/live/{live.module,live.controller,live.service,live.dto}.ts`, `src/storefront/storefront-checkout.service.ts`,
the three migrations above, and `test/phase4.e2e-spec.ts`.

**Changed (API):**
- `src/app.module.ts`.
- `src/storefront/{storefront.controller,storefront.module,storefront-public.service}.ts`: checkout and tracking
  routes, and a public `resolveTenant()`.
- `prisma/schema.prisma`, `prisma/seed.ts` (hold settings), `test/env.js` (checkout rate limit raised for tests).

**New (web):** `src/app/(app)/orders/{page,new/page,[id]/page,[id]/edit/page,[id]/print/page}.tsx`,
`src/app/(app)/live/{page,new/page,[id]/page}.tsx`,
`src/app/store/[slug]/{checkout/page,order/[reference]/page}.tsx`,
`src/components/{order-form,live-session-form}.tsx`, `src/components/store/{checkout-form,order-tracking}.tsx`,
`src/lib/{order-labels,order-labels.test}.ts`.

**Changed (web):** `src/lib/types.ts`, `src/components/app-shell.tsx` (navigation; hidden when printing),
`src/components/store/cart-view.tsx` (checkout button), `src/app/(app)/customers/[id]/page.tsx` (order links).

## Blocked or incomplete
1. **Payments**: see the decision above. Online payment (Phase 5) and bank-transfer verification (Phase 7) are the
   only ways an order becomes paid, so the receipt, fulfilment and sales figures only fill up once they exist.
2. **Refunds** (paid → refunded / partly refunded) are reserved for the payments module (Phase 5).
3. **Delivery** fees are entered by hand. Delivery zones, courier tracking and the dispatch record (`delivery_orders`)
   come with logistics in Phase 10.
4. **Customer notifications** (order confirmation, payment reminders, dispatch) arrive with Veltrix in Phases 8–9.
   For now the tracking page and the WhatsApp button cover it.
5. **TikTok / Instagram live comments are not read automatically.** Orders are taken by product code or manual entry
   (rule 10); platform APIs for live comments need approval we don't have.
6. **Still open from earlier phases:** the commission rate and limits (placeholders), legal review, company details
   for the legal pages, trial/grace timing vs. Phase 5, and the unverified local MinIO setup.
7. **Housekeeping found during smoke tests:** stopping a background `next start` from this tool leaves its Node child
   running. I stop leftovers on ports 3000/4000 after each smoke test; this has nothing to do with the app itself.

## Needed from you
- **The decision above:** wait for Phase 5, or bring manual transfer verification forward.
- Go-ahead for Phase 5 (payment abstraction + Paystack). It needs Paystack **test** keys (secret + public) and
  access to the Paystack dashboard's webhook settings.
