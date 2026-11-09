# Phase 10 report — Logistics, analytics and reporting

Scope: MASTER-SPEC §28 Phase 10, covering:

- §18 logistics and delivery;
- §19 live selling analytics with CSV and PDF reports;
- the reporting side of §14's plans ("Sales analytics" from Professional).

The seller dashboard (§7, Phase 2) is unchanged and stays on every plan.

## Status at a glance

| Check | Result |
|---|---|
| API unit tests | **117 / 117**: 104 earlier + 13 new (zone matching, quotes, delivery status rules, date ranges, rates, CSV) |
| API e2e | **193 / 193**: 184 earlier + **8 Phase 10** + **1 WhatsApp delivery** test in the Phase 9 suite, incl. the real Paystack, Flutterwave and Bachs sandbox calls; the 4 opt-in live-Veltrix tests are skipped |
| Web tests (Vitest) | **28 / 28** |
| `tsc --noEmit`, `nest build`, `next build` | clean |
| Drift check after the new migration | empty |

**Two intermittent failures during the runs, both green on re-run:**
- **Flutterwave's sandbox** timed out on authenticated calls for a while (20 s, confirmed with a plain Node `fetch`
  outside the app). It passed on the final run. Nothing in Flutterwave's code changed in this phase.
- **One Phase 4 test** failed once in a full run. It passed alone, in two full Phase 4 runs, and in the final full run.
  It doesn't touch Phase 10 code. I couldn't capture its message, so the cause is unknown; most likely test-data
  timing. I'll watch for it.

## Needs your attention

1. **Which courier(s) to integrate.**
   - The logistics port is in place, but the only adapter is "recorded by the seller". Sellers enter the courier,
     tracking number and status by hand (§18 allows this "where integrations are unavailable").
   - To add a courier API (for example GIG Logistics, Kwik, Sendbox, Topship), I need the provider's official API
     docs and sandbox credentials (CLAUDE.md rule 6). Tell me which ones.
2. **Plan gating.**
   - Analytics and reports (`/analytics`, CSV, PDF) need a plan with `features.analytics` set: Professional,
     Business, Enterprise and Commission in the seed. Starter gets a clear upgrade message and keeps the dashboard.
   - "standard" and "advanced" currently unlock the same thing. Tell me if Business/Enterprise should get more
     (longer ranges, scheduled email reports, …).
3. **No PDF layout check.** No PDF renderer is installed on this machine, so the report's layout hasn't been looked at.
   The e2e test checks that a valid PDF comes back with the right headers and that the export is audited. Please open
   one and tell me if it needs changes.
4. **Still open from earlier phases:**
   - Veltrix credentials and Meta templates;
   - setting the platform number's Meta app secret in Veltrix (the signature check itself is now built);
   - the Bachs refund scope and `connect`;
   - webhook secrets;
   - commission on direct and transfer payments;
   - messaging prices and limits;
   - the 72 h / 24 h thresholds;
   - virtual accounts.

## What was built — logistics (§18)

### Settings, zones and pricing (`src/logistics/`)

- **Delivery zones** (`delivery_zones`, Phase 1 table, now used):
  - name, states and/or cities, fee in kobo, days (0–60), on/off;
  - routes: `POST/PATCH/DELETE /delivery/zones` (`delivery:manage`) and `GET /delivery/settings` (`orders:read`);
  - at most 100 zones per store;
  - DB checks: `fee_minor >= 0`, `eta_days` 0–60;
  - a zone that past orders used is **switched off instead of deleted**, so those orders keep their zone;
  - audited.
- **How a zone is matched** (`delivery-rules.ts`, pure):
  - a zone that lists cities applies only to those cities (inside its states);
  - a states-only zone covers the whole state;
  - matching ignores case, spacing and "State";
  - a city match beats a state match; among equals the **cheaper** zone wins;
  - inactive or empty zones never match.
- **Store settings** (`storefront_settings.delivery_settings`, `PUT /delivery/settings`):
  - pickup on/off, with a required pickup address and optional hours/instructions;
  - "accept orders to places no zone covers" (default on).
  - When that is on, such orders go in with no fee and the seller agrees it. When it is off, checkout refuses them
    (`DELIVERY_UNAVAILABLE`) and pickup still works.
  - With no zones at all, the pre-Phase-10 behaviour applies: the fee is agreed with the seller.
- **The server prices every customer order.**
  - `DeliveryService.priceFor()` runs at storefront checkout (new `deliveryMethod: DELIVERY | PICKUP`; the address is
    needed only for delivery) and when an order is placed over WhatsApp.
  - The fee is written to the order and a delivery record is created in the same transaction.
  - A client can't send a fee: it isn't a checkout field, and unknown fields get a 400.
  - Staff-entered orders keep their manual fee field.
- **Public quote:** `GET /store/:slug/delivery-options?state=&city=` returns the fee and zone, the days, whether the
  fee is "to be agreed", and pickup. For display only; the order is priced again on submit.
- **WhatsApp ordering (Phase 9 flow):**
  - the summary shows the zone fee, the new total and the delivery days;
  - PICKUP is refused politely when the store doesn't offer it;
  - an address outside the zones is refused when the store says so;
  - the price is computed again when YES is sent.

### Per-order delivery (`delivery_orders`)

- **Fields:** method (pickup / own delivery / courier), zone, `logistics_provider` (adapter key, `manual`),
  `carrier_name` (new), tracking reference, dispatch note, `problem_note` (new), dispatched/delivered times.
- **Statuses** (`DELIVERY_TRANSITIONS`):

  | From | Can move to |
  |---|---|
  | PENDING | ASSIGNED, IN_TRANSIT, DELIVERED, FAILED |
  | ASSIGNED | IN_TRANSIT, DELIVERED, FAILED |
  | IN_TRANSIT | DELIVERED, FAILED, RETURNED |
  | FAILED | ASSIGNED, IN_TRANSIT, DELIVERED, RETURNED (retry) |
  | DELIVERED, RETURNED | nothing (terminal) |

  - A **pickup** is only collected (DELIVERED) or FAILED; it has no rider, transit or return.
  - FAILED and RETURNED need a reason.
- **The order and its delivery move together, in one transaction.**
  - `OrdersService.transition()` is now a thin wrapper around a new `transitionTx()`, which `DeliveryService` also uses.
  - IN_TRANSIT **dispatches** the order: the stock sale is committed, history is written, and the Phase 9
    `ORDER_DISPATCHED` message carries "Sent with GIG Logistics, tracking GIG-123456". DELIVERED **delivers** it.
  - Moving the order with the old status endpoint keeps the delivery in step: a record is created if missing, it
    becomes IN_TRANSIT / DELIVERED, and the times are stamped.
  - FAILED and RETURNED add a history line **without** a status change and without a customer message. What happens to
    the money (refund) and the stock (adjustment) stays a deliberate seller action.
- **Access:**
  - delivery runs only for **paid** orders (PAID → DELIVERED); unpaid orders get 409;
  - changing a delivery needs `orders:update_status`, the same as moving the order (sales assistants yes, live
    moderators no);
  - everything is tenant-scoped (another store's order or zone returns 404) and audited (`delivery.*`).
- **Routes:**
  - `GET/PUT /orders/:id/delivery`;
  - `POST /orders/:id/delivery/status`;
  - `GET /deliveries?status=` (dispatch board). "To send" includes paid orders nobody has opened a delivery for yet.
- **Customer tracking page:** delivery status, courier, tracking number and expected days; for pickup, the address and
  instructions.

### Logistics port (`logistics-provider.ts`)

- `LogisticsProvider` describes capabilities (booking / quotes / tracking) and an optional `createShipment`.
  `LogisticsRegistry` lists the adapters.
- `ManualLogisticsAdapter` is the only adapter.
- A courier API becomes a new adapter plus a registry entry. Business logic doesn't change (§18: "do not hardcode
  logistics providers").

## What was built — analytics and reports (§19)

`GET /analytics?from=&to=&channelId=` (`reports:read`, plan-gated) returns:

| Part | Contents |
|---|---|
| **Summary** | orders, paid, awaiting payment, cancelled, gross sales, refunds, net sales, average order value, units sold, payment completion and cancellation rates, live sessions, orders from live, buyers, new customers, repeat buyers and repeat-purchase rate |
| **Comparison** | each figure against the **previous period of the same length** |
| **Series** | paid sales and orders per day (≤ 62 days), week (≤ 190) or month, zero-filled |
| **Channels** | side by side: orders, paid, gross, average order value, completion, cancellation, new customers acquired |
| **Live sessions started in the range** | orders, paid, gross, units, average order value, completion, buyers, peak viewers, conversion |
| **Top 10 products** | units, orders, revenue |

**Definitions** (also in `analytics.service.ts`):
- **Orders** are counted by the day they were placed (Africa/Lagos), in the store currency.
- **Paid** = payment status PAID / PARTIALLY_REFUNDED / REFUNDED. Only verified payments set these.
- **Net sales** = gross − completed refunds.
- **Rates** are integer basis points; there are no floats anywhere.
- **New customer** = first-ever order in the range (on that channel, when filtered).
- **Repeat buyer** = a buyer in the range with ≥ 2 paid orders by the end of the range.

**Viewers are never estimated (§19).**
- A session's conversion (buyers ÷ peak viewers) appears only when peak viewers were recorded.
- It is labelled `seller_reported`. Sessions without viewer data show "No viewer data".

**Range and query rules:**
- whole Lagos days; default the last 30; at most 366;
- no future dates; invalid dates get 400;
- the channel filter is checked against the store (another store's channel returns 404).

**Exports** (audited as `analytics.exported`):
- **CSV:** `GET /analytics/export?report=summary|daily|channels|sessions|products`. Amounts in naira with 2 decimals,
  rates in percent. No customer personal data.
- **PDF:** `GET /analytics/report.pdf`, generated with `pdfkit` 0.20.2 (pinned; released 2026-08-30).
  - **Contents:** store, period, the comparison period, summary vs previous period, channels, sessions (with the
    viewer-data footnote), top products, and the definitions.
  - **Money format:** shown as "NGN 25,000.00", because the standard PDF fonts have no ₦ glyph. Text outside Latin-1
    is replaced so the file never breaks.

**Plan gate:** `features.analytics` on the live plan; otherwise 403 `FEATURE_NOT_IN_PLAN`.

**Tenant isolation:** all SQL takes the tenant id as a bound parameter and filters every joined table by it.

## Web (`apps/web`)

- **Analytics** (`/analytics`, new nav item):
  - period presets (7/30/90 days, this or last month, 12 months) or a custom range with validation, and a channel
    filter;
  - KPI cards with change badges against the previous period, and the paid-sales chart (reusing the dashboard chart);
  - channel, live-session and top-product tables;
  - CSV export (choose the table) and PDF download;
  - loading, empty, error and "upgrade your plan" states.
- **Deliveries** (`/deliveries`): the dispatch board, with tabs To send / Rider assigned / On the way / Problems /
  Delivered / Returned / All paid, linking to the order.
- **Settings → Delivery:** pickup and coverage settings, zone add / edit / switch off / remove (with the
  "switched off because past orders used it" message), and the list of logistics adapters. Read-only without
  `delivery:manage`.
- **Order page:** a **Delivery** card:
  - method, courier, tracking number, note;
  - status buttons ("Mark on the way", "Mark collected" for pickup…), with a required reason for failed or returned;
  - dispatched/delivered times;
  - "Delivery starts once the payment is verified" for unpaid orders.
- **Checkout:**
  - deliver or pick up (when the store offers pickup), with the pickup address;
  - a live fee quote for the typed city and state, shown in the order summary and total, plus the days;
  - an "outside our delivery area" message that blocks submit when the store doesn't deliver there.
- **Order tracking:** the delivery state, courier and tracking number, or the pickup details.

## Files

**API, new:**
- `src/logistics/`: `delivery-rules.ts`, `logistics-provider.ts`, `delivery.service.ts`, `delivery.controller.ts`,
  `logistics.module.ts`, `logistics.spec.ts`
- `src/analytics/`: `analytics-math.ts`, `analytics.service.ts`, `analytics-export.ts`, `analytics.controller.ts`,
  `analytics.module.ts`
- `prisma/migrations/20261108090000_phase10_logistics/`
- `test/phase10.e2e-spec.ts`

**API, changed:**
- `prisma/schema.prisma`: `storefront_settings.delivery_settings`, `delivery_orders.carrier_name`/`problem_note` and
  the zone relation, `delivery_zones.updated_at`
- `src/app.module.ts`
- `src/orders/orders.service.ts`: `transitionTx`, delivery sync, server-priced delivery on create
- `src/orders/orders.dto.ts`: `deliveryMethod`; address optional for pickup
- `src/storefront/storefront-checkout.service.ts`, `storefront.controller.ts`, `storefront.module.ts`
- `src/automation/whatsapp-commerce.service.ts`, `automation.module.ts`
- `test/phase9.e2e-spec.ts`: WhatsApp delivery pricing test
- `package.json`: `pdfkit`, `@types/pdfkit`

**Web, new:**
- `app/(app)/analytics/page.tsx`, `app/(app)/deliveries/page.tsx`, `app/(app)/settings/delivery/page.tsx`
- `components/order-delivery.tsx`
- `lib/analytics-labels.ts`, `lib/delivery-labels.ts` (+ `analytics-labels.test.ts`)

**Web, changed:**
- `components/app-shell.tsx` (nav)
- `app/(app)/orders/[id]/page.tsx`
- `components/store/checkout-form.tsx`, `components/store/order-tracking.tsx`
- `lib/api.ts`: `apiBlob`
- `lib/download.ts`: `downloadFile`
- `lib/types.ts`

## Tests (e2e, `test/phase10.e2e-spec.ts`)

- **Zones:**
  - only `delivery:manage` can change them;
  - validation: a zone must cover somewhere, and the fee must be non-negative whole kobo;
  - another store gets 404 and an empty list;
  - the manual adapter is listed;
  - changes are audited.
- **Checkout pricing:**
  - the city zone (₦1,500) beats the state zone (₦3,000);
  - the total includes the fee;
  - a client-sent fee is refused with 400;
  - the delivery record carries its zone;
  - the tracking page shows the fee and the delivery.
- **Outside the zones:**
  - the fee is agreed later, or refused (`DELIVERY_UNAVAILABLE`) when the store says so;
  - pickup is refused until it's enabled, and enabling it needs an address;
  - a pickup order needs no address and has no fee;
  - the tracking page shows the pickup address.
- **Courier delivery:**
  - unpaid gets 409;
  - a courier name is needed for a third-party delivery;
  - a moderator gets 403 and a sales assistant is allowed;
  - IN_TRANSIT dispatches the order (stock committed), and the outbox note reads "Sent with GIG Logistics, tracking
    GIG-123456";
  - FAILED needs a reason and writes a history line but no customer event;
  - a retry then DELIVERED delivers the order;
  - nothing moves after DELIVERED;
  - the tracking page shows the courier;
  - 4 audits;
  - another store gets 404.
- **Pickup:** collected with no transit allowed. Staff orders moved with the old status endpoint keep their delivery
  in step. The board lists paid orders without a record under "To send" and shows the delivered ones.
- **Zone removal:** a used zone is switched off and stops pricing; an unused one is deleted.
- **Analytics plan gate:** Starter gets 403 `FEATURE_NOT_IN_PLAN` (JSON and PDF); 200 after upgrading; a live
  moderator without `reports:read` gets 403.
- **Analytics figures, with real orders:**
  - repeat customer, unpaid, cancelled, two TikTok live orders, a partial refund, and an order 40 days back;
  - **exact figures:** 6 orders / 3 paid / ₦100,000 gross / ₦10,000 refunded / ₦90,000 net / average order value
    ₦33,333.33 / 4 units / 50 % completion / 16.67 % cancellation / 1 repeat buyer of 2 / 5 new customers;
  - the previous period shows 1 paid order, ₦25,000;
  - the channel split; the session with 40 recorded viewers shows 2.5 % conversion, the session without shows none;
  - top product; today's bucket;
  - the channel filter; another store's channel gets 404 and the other store sees zero;
  - range validation; a single past day;
  - CSV summary and sessions exports;
  - an unknown report gets 400;
  - the PDF is returned with `%PDF-` and the correct content type, and 3 exports are audited.
- **WhatsApp (Phase 9 suite):** the zone fee, total and days appear in the summary; pickup is refused when not offered;
  the order has the fee and a delivery record.

## Blocked or incomplete

- **Courier API integrations:** blocked on choosing providers and getting their docs and sandbox credentials (see
  "Needs your attention" #1).
- **Not built:**
  - automatic stock return or refunds when a delivery is RETURNED; those stay manual on purpose;
  - customer notifications for "rider assigned" and "delivery failed": only dispatched and delivered are sent (Phase 9
    events);
  - analytics beyond §19: hourly heat-maps, cohort retention, scheduled email reports;
  - a per-session PDF: the live-session page keeps its JSON report, and sessions are in the period PDF and CSV;
  - TikTok/Instagram viewer data from platform APIs: none are integrated, so conversion relies on seller-recorded
    peak viewers, labelled as such.
- **Flutterwave sandbox:** intermittent timeouts on authenticated calls; green on the final run (see "Status at a glance").


---

# Phase 10 follow-up (10b): your decisions of 2026-11-06

What you asked for:
- start delivery with private couriers;
- build the Business and Enterprise tier;
- let a seller use the whole app with no fixed fee, while LiveSell earns commission on every sale.

## Status at a glance (after 10b)

| Check | Result |
|---|---|
| API unit tests | **123 / 123**: 117 + 6 new (commission invoice maths, Lagos months, settlement journal, tiers and report periods, report email, courier phone) |
| API e2e | **201 / 201**: 193 + **8 new** in `test/phase10b.e2e-spec.ts`; the 4 opt-in live-Veltrix tests are skipped |
| Web tests | **29 / 29** |
| `tsc`, `nest build`, `next build`, drift check | clean |

**Test-harness fix:**
- The fake payment provider numbered its references `ps_1`, `ps_2`… from scratch in every test file.
- Those references collided in the shared test database, where `provider + provider_reference` must be unique.
- The new suite exposed this as random 500s in Phase 5, 6 or 10b.
- References are now unique per test file (`test/support.ts`). This is probably also what caused the earlier one-off
  Phase 4/5 failures.

## 1. Private couriers (`couriers`)

- **Each store keeps its own couriers:**
  - riders on its team (`RIDER`) and courier companies it books itself (`COMPANY`);
  - each with a phone, notes, and an option to show the phone to customers;
  - routes: `POST/PATCH/DELETE /delivery/couriers` (`delivery:manage`), listed in `GET /delivery/settings`;
  - tenant-scoped (another store's courier returns 404) and audited;
  - a courier who carried orders is switched off rather than deleted.
- **On an order:** `PUT /orders/:id/delivery { courierId }` fills in the carrier name, kept as written at the time.
  Switched-off couriers can't be picked, and a pickup has no courier.
- **What the customer sees:** with "show phone" on, the dispatch message reads "Sent with Musa (rider)
  (+2348030000001)". The tracking page shows a tap-to-call number while the order is on its way, not after delivery.
  The option is off by default.
- **Dispatch board:** `?courierId=` shows one courier's deliveries.
- **Web:**
  - a "Your couriers" card on Settings → Delivery;
  - a courier picker on the order's delivery card ("someone else" still lets staff type a name).
- **Courier APIs:** the logistics port stays ready. Add one when you pick a provider and have its docs and sandbox keys.

## 2. Business and Enterprise: advanced analytics

The plan's `features.analytics` now picks a tier:

| | Standard (Professional) | Advanced (Business, Enterprise, Pay as you sell) |
|---|---|---|
| Range per report | up to 92 days | up to 366 days |
| Summary, comparison, channels, sessions, top products, CSV | yes | yes |
| PDF report | — | yes |
| Weekday × hour order pattern (heat-map + CSV) | — | yes |
| Top customers by paid spend (names only; CSV without phone/email) | — | yes |
| Weekly / monthly email reports | — | yes |

**How the gate answers:**
- Anything outside the tier returns 403 `FEATURE_NOT_IN_PLAN` with the feature named (`analytics.long_range`,
  `analytics.pdf`, `analytics.customers`, `analytics.schedules`).
- The web page explains this and offers the upgrade.

**Email reports** (`report_schedules`, `GET/PUT /analytics/schedules`):
- **Schedules:** one weekly report per store, sent Monday morning for the previous Monday–Sunday. One monthly report,
  sent on the 1st for the previous month.
- **Recipients:** chosen from members who can read reports. Changing the schedule needs `store:manage`.
- **Sending:** an hourly job sends from 07:00 Lagos.
  - Each person gets it once per period (dedupe key).
  - It goes through `NotificationService`, so the email counts towards the store's messaging usage.
- **Contents:** the key figures against the period before, the top product, the best channel, and a link to the full
  report.
- **Plan downgrade:** if the plan drops below advanced, nothing is sent and the schedule waits.

**Enterprise** has the same analytics as Business. Its extras stay in its plan limits and features:
- unlimited use;
- dedicated support;
- custom integrations;
- custom pricing, assigned by LiveSell rather than chosen in the app.

## 3. Pay as you sell: the whole app, commission on every sale

**The plan:**
- `PAY_AS_YOU_SELL` now has **no monthly fee** and **no limits** (products, orders, staff, gateways).
- It has every feature: advanced analytics, WhatsApp, automation, advanced inventory and order management.
- The default commission is **3% (300 bps)**, a placeholder you can edit as admin.
- The data migration `20261109090100_phase10b_commission_data` updated the existing plan row, and the seed matches.
- **No commission during the 14-day trial**, as before.

**How every sale pays its commission:**

| How the customer paid | How LiveSell gets its commission |
|---|---|
| Split payment (Paystack/Flutterwave subaccount) | taken at source by the gateway (unchanged) |
| Seller's own gateway key (DIRECT) or bank transfer | recorded as owed on each verified sale (unchanged); refunds reduce it; **now invoiced monthly** |

**Monthly commission invoice** (`CommissionBillingService.issueDue`, an hourly, idempotent job):
- **What's invoiced:** on the 1st (Lagos), each store gets an invoice for the commission accrued on its own
  collections up to the month's start, minus earlier commission invoices.
- **Amounts and timing:**
  - amounts under ₦1,000 carry over (`commission.min_invoice_minor`);
  - the invoice is due in 7 days (`commission.invoice_due_days`).
- **Uniqueness:** one invoice per store per month, enforced by an advisory lock plus a partial unique index.
- **Delivery:** emailed through `BillingNotifier`.

**Paying it:**
- The seller pays it like any LiveSell invoice (platform Paystack), and it is verified server-side.
- The ledger posts balanced journals on both sides. The seller's payable is cleared. On the platform side, the
  receivable becomes cash, net of the gateway fee.
- Paying it never changes the plan or period.
- Plan changes and expiry never void a commission invoice.

**If it isn't paid:**
- Once it is unpaid past its due date plus `billing.grace_days` (3), tenant writes return 402 `COMMISSION_OVERDUE`.
- Reads, the storefront and billing recovery keep working.
- Paying lifts the block at once.

**Seller view:** `GET /billing/commission`, shown as a **Commission** card on Plan & billing:
- the rate;
- this month's commission on the seller's own collections;
- the amount not yet invoiced;
- what was taken at source;
- the invoices, with Pay now and overdue warnings.

**Placeholders to confirm:** the 3% rate, the ₦1,000 minimum, 7 days to pay, and the 3-day grace before writes
pause. All of them are editable platform settings or plan fields.

**Not yet** (both Phase 11, super-admin dashboard):
- a platform-admin view of commission receivables across stores;
- waiving or writing off a commission invoice.

## Files (10b)

**API, new:**
- `src/billing/commission-billing.service.ts`
- `src/analytics/report-schedules.service.ts`
- `src/analytics/analytics.jobs.ts`
- `src/notifications/analytics-report.ts`
- migrations `20261109090000_phase10b_commission_couriers` and `20261109090100_phase10b_commission_data`
- `test/phase10b.e2e-spec.ts`

**API, changed:**
- `prisma/schema.prisma`: `InvoiceKind.COMMISSION`, `Courier`, `ReportSchedule`, `delivery_orders.courier_id`
- `prisma/seed.ts`
- `src/billing/`: `billing-notifier`, `billing.jobs`, `billing.module`, `billing.controller`, `subscriptions.service`
- `src/ledger/ledger.service.ts`: `commissionSettlementJournals`
- `src/payments/payments.service.ts`
- `src/common/auth/guards.ts`: `COMMISSION_OVERDUE`
- `src/notifications/`: `templates`, `veltrix-mailers`
- `src/analytics/`: `analytics-math`, `analytics.service`, `analytics.controller`, `analytics-export`, `analytics.module`
- `src/logistics/`: `delivery-rules`, `delivery.service`, `delivery.controller`, `logistics.spec`
- `src/prisma/tenant-scope.extension.ts`
- `test/support.ts`, `test/phase10.e2e-spec.ts`

**Web, new:**
- `components/commission-card.tsx`
- `components/couriers-card.tsx`
- `components/analytics-advanced.tsx`

**Web, changed:**
- pages: `settings/billing`, `settings/delivery`, `analytics`
- `components/order-delivery.tsx`, `components/store/order-tracking.tsx`, `components/plan-features.ts`
- `lib/types.ts`, `lib/analytics-labels.test.ts`
