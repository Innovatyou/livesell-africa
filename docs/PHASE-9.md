# Phase 9 report — WhatsApp commerce automation and customer notifications

Scope: MASTER-SPEC §28 Phase 9, covering:

- §16 WhatsApp ordering automation;
- the §15 notification list (order confirmation, payment confirmation, payment and abandoned-checkout reminders,
  dispatch and delivery updates; receipts and invoices by email; order and payment alerts by SMS);
- §26 #10 (a notification failure never blocks an order).

It builds on the Phase 8 messaging layer: `NotificationService` and the Veltrix adapters.

The Veltrix source (`C:\laragon\www\mailwizz-yii3`) was the reference for every endpoint and field. Inbound WhatsApp
messages needed one more additive change there (forwarding, below).

**Decision recorded this phase:** the LiveSell mobile app will be **React Native + TypeScript** (`apps/mobile`).
- It gets its own phase after Phase 10.
- It uses the same `/api/v1` API, with mobile sessions via `X-Client-Type: mobile`.
- It is recorded in MASTER-SPEC's decisions box and in CLAUDE.md.

## Status at a glance

| Check | Result |
|---|---|
| API unit tests | **104 / 104**: 91 earlier + 13 new (channel plan, preferences, event mapping, templates, parser, forward signature, adapter forwarding/templates) |
| API e2e | **184 / 184**: 171 earlier + **13 Phase 9**. The 4 opt-in live-Veltrix tests are skipped by default, as before |
| Web tests (Vitest) | **24 / 24** |
| `tsc --noEmit`, `nest build`, `next build` | clean |
| Drift check after the new migration | empty |
| Veltrix side | forwarding check script **18 / 18** (real HTTP to a local receiver, retries, signature, bot silence, switch-off); idempotency check **17 / 17** |

## Needs your attention

1. **Approved WhatsApp templates on the platform number.** Meta allows free text only within 24 hours of the customer's
   last message. Outside that window LiveSell must use a template that Meta has approved.
   - **How to set them up:**
     - Create one **Utility** template per order update in Meta Business Manager, with **numbered** values
       (`{{1}}`, `{{2}}`…) and **no media header**.
     - Map each template in *Platform admin → Integrations → WhatsApp ordering and order updates*.
     - The page shows which values each update sends, in order. For example, the payment reminder sends name, store,
       order number, total, hold time and link.
   - **Until a template is mapped**, updates outside the window go by SMS (when the store allows SMS).
   - **A mapping is refused if:**
     - the template isn't approved;
     - its number of values is wrong;
     - it uses named values;
     - it needs a media header.
2. **Connect forwarding once the Veltrix changes are deployed.**
   - Set `VELTRIX_WHATSAPP_SERVER_UID` (Phase 8).
   - Press **Connect forwarding** on the same admin page. Veltrix starts sending the platform number's inbound
     messages to `API_PUBLIC_URL/api/v1/whatsapp/webhook`.
   - The secret is stored encrypted.
   - While forwarding is on, the Veltrix bot and AI agent stay silent for that number.
3. **Veltrix now verifies that inbound messages come from Meta** (fixed 2026-11-08, Veltrix migration 176).
   - **Protection:** Meta signs every webhook with `X-Hub-Signature-256`. Veltrix refuses (403) unsigned or wrongly
     signed requests for any number whose Meta app secret it knows.
   - **Forwarding:** only verified messages are forwarded to LiveSell.
   - **Action needed:** in Veltrix (*WhatsApp servers → edit → Webhook security*), mark the platform number as
     "Connected with Facebook" (the platform app secret in `whatsapp_meta.php` is used), or enter its own Meta app
     secret.
   - **Until then:** forwarding to LiveSell stays silent for that number on purpose; unverified messages are dropped,
     not forwarded.
   - Even before the fix, a forged message could never mark anything paid. It could only create an unpaid,
     rate-limited order whose stock hold expires.
4. **Platform number for "Order on WhatsApp".**
   - Set it on the same page (international format).
   - Store product pages show the button only when the number is set, forwarding is connected and WhatsApp is on.
5. **Still open from earlier phases:**
   - Veltrix credentials;
   - messaging prices and limits (placeholders), and whether to invoice seller messaging cost;
   - the Bachs key with `refunds:write` and the `connect` capability;
   - webhook secrets;
   - commission on direct and bank-transfer payments;
   - the 72 h transfer hold and 24 h stale thresholds;
   - virtual accounts.

## What was built (LiveSell API)

### Order events: transactional outbox (`outbox_events`)

- **Written in the same transaction as the change.** `OrdersService.history()` writes an outbox row in the same
  database transaction as the status change, whenever the change matters to the customer (`customerEvent(from, to)`):

  | Status change | Event |
  |---|---|
  | placed | `ORDER_PLACED` |
  | paid | `PAYMENT_RECEIVED` |
  | transfer reported | `TRANSFER_REPORTED` |
  | transfer not found | `TRANSFER_NOT_FOUND` |
  | dispatched | `ORDER_DISPATCHED` |
  | delivered | `ORDER_DELIVERED` |
  | cancelled | `ORDER_CANCELLED` |
  | refunded | `REFUND_COMPLETED` |

  - A rolled-back change therefore never sends a message.
  - A committed change is never lost if the API restarts.
- **Table rules:** append-only (a trigger allows only `attempts`, `error`, `processed_at` to change, and nothing to be
  deleted). Tenant-scoped.
- **Dispatch:** the `OrderNotifier.dispatchOutbox()` job runs every 15 s on a new `automation` BullMQ queue.
  - Each row is claimed with a compare-and-set on `attempts`, so several workers are safe.
  - A row gets up to 5 attempts; errors are recorded on the row.
  - Payment is still recognised only in `PaymentsService.applyVerification()` and `BankTransferService.verify()`.
    "Payment confirmed" is sent only from the outbox row those write, i.e. **after server-side verification**
    (§16 "after payment verification, send order confirmation").

### Which channel (`src/automation/preferences.ts`, pure, unit-tested)

For each event, the store's preferences say WhatsApp / SMS / email. `planChannels()` then decides, in this order.

**WhatsApp** is used only when the customer:
- has a phone number;
- has opted in (a checkout checkbox, or ordering on WhatsApp);
- has not replied STOP;
- and the platform channel works.

When all of those hold, the message form depends on timing:

| Situation | What is sent |
|---|---|
| Customer wrote to the platform number in the last 24 h | Free text |
| Outside that window, an approved template is mapped | The template |
| Neither | Skipped, with the reason |

**SMS** is the fallback when WhatsApp isn't used, unless the customer opted out of SMS.

**Email** goes in addition when the customer gave an address.

**Defaults:**

| Message | Default channels |
|---|---|
| Invoice on order placed | Email included |
| Receipt on payment confirmed | Email included |
| Refund notice | Email included |
| Transfer-report acknowledgement | WhatsApp only |
| Payment reminder | 6 h before the stock hold ends |
| Abandoned-checkout nudge | 60 min after an unpaid online order |

- Sellers change these on *Settings → Messaging*. `GET/PUT /notifications/preferences` needs `store:manage`.
- An order placed **in** the WhatsApp conversation gets no WhatsApp/SMS "order placed" message; the conversation
  already answered.

### Sending (`OrderNotifier.notify`)

- **One message per event per channel:** dedupe key `order:<id>:<event>[suffix]:<channel>`. Refunds add the refund id
  so a second partial refund is announced too.
- **Sent through `NotificationService.send()`**, so every Phase 8 rule applies:
  - idempotent Veltrix calls;
  - retry and backoff;
  - monthly limits;
  - the cost row is billed to the store.
- **The customer's private order link:**
  - Storefront and WhatsApp orders now also keep their tracking token **encrypted** (`orders.tracking_token_enc`,
    `CryptoService.encrypt(token, tenantId)`), so messages can include the link.
  - Staff-entered orders get a link created on first message.
  - Storefront orders from before this phase only ever stored the token hashed, so their messages point to the store
    page and the original link keeps working.
- **Reminders** run in a job every 10 min (`runReminders`):
  - a payment reminder when the hold is close to ending;
  - an abandoned-checkout nudge for online orders left unpaid.
  - Each fires once per order.
- **Manual reminder:** `POST /orders/:id/notify { event: 'PAYMENT_REMINDER' }` (needs `orders:create`).
  - At most once every 6 hours per order (409 otherwise).
  - Only for unpaid orders.
  - Audited.
- **The seller sees every message about an order** at `GET /orders/:id/notifications`.
- **Templates** (`src/notifications/order-templates.ts`):
  - short SMS/WhatsApp text, an HTML email (invoice / receipt with the items table), and positional template values
    (`WHATSAPP_PARAMS`) for each event;
  - all values are HTML-escaped in email.

### WhatsApp ordering (`WhatsappCommerceService`, §16)

**Inbound route.** Veltrix forwards each message to `POST /api/v1/whatsapp/webhook`. LiveSell checks, in order:
- the `X-Veltrix-Signature` (`t=<unix>,v1=<HMAC-SHA256("t.body")>`, 5-minute tolerance, constant-time compare);
- a valid `X-Veltrix-Delivery`;
- then de-duplicates on the WhatsApp message id (`whatsapp_inbound_events`).

It returns 401 for a bad or missing signature, and Veltrix retries anything that isn't 2xx.

**The conversation** is one row per phone in `whatsapp_conversations`: state plus draft. It is reset after 24 h idle
and rate-limited to 30 messages per 10 min.

1. "ada-fashion BAG001" (or just "BAG001", or "adafashion bag001"): the words are looked up as store names. A code sold
   by several stores asks which store. Unknown, unpublished, suspended or unsubscribed stores are never offered.
2. The product is shown with its price. When it has several variants, a numbered list appears and sold-out options are
   marked. Prices and stock always come from the database.
3. Quantity (1–20, checked against live stock), then full name (skipped for a returning customer, whose saved address
   is offered), then the address as "street, city, state", or PICKUP.
4. A summary, then **YES**. `OrdersService.create(source: 'whatsapp')` runs: database prices, stock reserved with
   `FOR UPDATE`, the checkout hold, the customer opted in, and a WhatsApp sales channel created on first use.
5. The reply carries:
   - the order number and total;
   - the private link with **Pay now** when online payment is on;
   - the store's transfer account with the order number as the description;
   - the hold time;
   - a "Reply STATUS" hint.

**Commands at any point:**
- **STATUS:** the latest 3 orders with their state and links.
- **CANCEL / NO:** start over.
- **HELP**
- **STOP:** every store's customer record for that number stops getting WhatsApp messages; SMS/email still work. The
  conversation then stays silent.
- **START:** opts back in.
- Both STOP and START are audited.

**Status updates:** forwarded delivery statuses (`message.status`) move our message rows to DELIVERED or FAILED.

Replies are free text (the customer just wrote, so the window is open). They are billed to the store once known.

### Platform admin (`/admin/whatsapp`)

- **`GET`:** number, forwarding state, approved templates (live from Veltrix `GET /whatsapp/senders`) and the
  event → template mapping. Platform admin or support.
- **`PUT`:** set the number and the mapping, validated as described above. Platform admin only.
- **`POST /forwarding`:** connect forwarding (`PUT /whatsapp-servers/{uid}/forwarding` with `rotate_secret`).
  - The returned secret is encrypted with a platform-bound key and never returned to the browser.
  - Audited.
- **Public `GET /store/:slug/whatsapp-ordering`:** whether the button shows, and the number.

### Schema (migration `20261107080000_phase9_automation`)

- **Columns:**
  - `orders.tracking_token_enc`;
  - `customers.whatsapp_opt_out_at`, `customers.sms_opt_out`.
- **Tables:**
  - `outbox_events`: tenant-scoped, append-only trigger;
  - `notification_preferences`: one per store;
  - `whatsapp_conversations`: phone unique with an E.164 check;
  - `whatsapp_inbound_events`: delivery id unique.
- **`TENANT_SCOPED_MODELS`** adds OutboxEvent, NotificationPreference and WhatsappConversation. The conversation's
  tenant is nullable until a store is chosen.
- **Seed:** `whatsapp.templates` = `{}`.

## Changes in the Veltrix project (additive)

- **`migrations/175_whatsapp_forwarding.sql`** adds `mw_whatsapp_forward` (per server: url, secret, enabled,
  forward_statuses) and `mw_whatsapp_forward_delivery` (outbox with retries).
- **`WhatsappForwardService`** queues `message.received` / `message.status` and signs each delivery:
  - `X-Veltrix-Signature`, plus `X-Veltrix-Event` and `X-Veltrix-Delivery` (stable across retries).
  - Delivery is tried immediately, then retried by `whatsapp/forward-dispatch`, which is hourly from
    `cron/hourly`; the delivery is abandoned after its attempts run out.
  - Old rows are pruned.
- **`WhatsappForwardingController`:** `GET/PUT/DELETE /api/v1/whatsapp-servers/{server_uid}/forwarding`.
  - Only the owner's servers.
  - https only (http allowed for localhost and `.test`).
  - The secret is returned only on create or `rotate_secret`.
- **`WhatsappWebhookController`:** with forwarding on, an inbound message goes to the forward **instead of** the bot or
  AI agent (both the Meta and the generic gateway paths). Statuses are forwarded too.
- `docs/API.md` documents "Message forwarding" and the signature check.
- Phase 8's Idempotency-Key (migration 174) and quick-send message ids are unchanged.
- Nothing in Veltrix is committed (same as Phase 8).

## Web (`apps/web`)

- **Settings → Messaging:** a new **Automatic customer messages** card for store managers:
  - an on/off switch;
  - per-message WhatsApp/SMS/email checkboxes;
  - reminder timing with validation;
  - saved state.
- **Order page:** a **Customer messages** card listing the messages sent, with channel, status, failure reason and
  time.
  - **Send payment reminder** appears while the order is unpaid, for staff with `orders:create`.
  - It shows a clear result: sent by which channel, not sent and why, or "already sent recently".
- **Checkout:** an optional **"Send me order updates on WhatsApp"** checkbox (unticked by default), explaining STOP.
- **Product page:** **Order on WhatsApp** opens the platform number with "<store> <code>" pre-filled. It shows only
  when ordering is on and the item is in stock.
- **Platform admin → Integrations:** a **WhatsApp ordering and order updates** card:
  - forwarding status with Connect / Reconnect;
  - the platform number;
  - a template picker per update, which offers only templates that fit and shows the values sent in order;
  - loading, empty and error states.

## Files

**API, new:**
- `src/automation/automation.module.ts`, `automation.controller.ts`, `automation.jobs.ts`
- `src/automation/order-notifier.service.ts`, `preferences.ts`, `whatsapp-commerce.service.ts`,
  `whatsapp-admin.service.ts`, `automation.spec.ts`
- `src/notifications/order-templates.ts`, `html.ts`
- `prisma/migrations/20261107080000_phase9_automation/`
- `test/phase9.e2e-spec.ts`

**API, changed:**
- `prisma/schema.prisma`, `prisma/seed.ts`
- `src/app.module.ts`
- `src/orders/orders.service.ts`: outbox in `history()`, `source: 'whatsapp'`, encrypted token, opt-in, WhatsApp
  channel on demand
- `src/orders/orders.dto.ts`: `whatsappOptIn`
- `src/storefront/storefront-checkout.service.ts`
- `src/notifications/notifications.service.ts`: template sends, `applyWhatsappStatus`, `forOrder`
- `src/notifications/templates.ts`
- `src/messaging/messaging-provider.ts`, `veltrix.adapter.ts` (+ spec): forwarding, templates
- `src/prisma/tenant-scope.extension.ts`
- `test/support.ts`

**Web, new:**
- `src/components/order-messages.tsx`, `message-preferences.tsx`, `whatsapp-admin-card.tsx`

**Web, changed:**
- `settings/messaging/page.tsx`, `orders/[id]/page.tsx`, `admin/integrations/page.tsx`
- `components/store/checkout-form.tsx`, `components/store/product-buy-box.tsx`
- `app/store/[slug]/p/[productSlug]/page.tsx`
- `lib/types.ts`, `lib/messaging-labels.ts` (+ test), `lib/storefront.ts` (+ test)

**Veltrix:** see the section above.

## Tests (e2e, `test/phase9.e2e-spec.ts`)

- **Online order:**
  - SMS + email invoice exactly once (the job run twice);
  - the link in the SMS is the customer's working private link;
  - no WhatsApp without opt-in;
  - the seller's message list is scoped to their store.
- **Opted-in customer:**
  - the admin mapping is refused for an unapproved template, the wrong number of values, or named values;
  - an approved template is used outside the window (values checked);
  - free text is used inside the window after a verified bank transfer;
  - a WhatsApp-only event without a template is not sent by SMS.
- **Preferences:**
  - permission (sales assistant 403);
  - an event switched off isn't sent;
  - the store switch off sends nothing, and the event is still marked processed.
- **Messaging outage:** the order is unaffected, the message is queued for retry, and replaying the event doesn't
  duplicate it.
- **Reminders:** payment reminder and abandoned-checkout nudge once each; none for paid orders.
- **Manual reminder:**
  - non-members get 403 and other stores get 404;
  - a second reminder within 6 h gets 409 and isn't audited twice;
  - a paid order gets 409;
  - an unsupported event gets 400.
- **Webhook security:**
  - 401 before forwarding is connected, for a wrong secret, garbage, a stale timestamp, or no signature;
  - only an admin can connect;
  - the secret is never returned or stored in plain text.
- **Inbound handling:**
  - a retried delivery with the same message id is handled once;
  - a forwarded "delivered" status updates the message row.
- **Full WhatsApp conversation:**
  - quantity above stock is refused and a bad address re-asked;
  - the order is created on the WhatsApp channel with database prices, 2 units reserved and the customer opted in;
  - the reply carries a working private link and the transfer account;
  - no duplicate "order placed" message;
  - STATUS lists the order;
  - replies are attributed to the store.
- **Store-name-only start, unknown code, CANCEL, HELP:** no order is created.
- **STOP:** the customer is opted out and the bot goes silent; payment confirmation then goes by SMS. START opts back in.
- **Unpublished store:** never offered and no order; the ordering endpoint returns 404 and reports "off" when WhatsApp
  is off.

## Blocked or incomplete

- **Live end-to-end with real WhatsApp:** needs Veltrix credentials, a connected WhatsApp server for the platform
  number, approved templates, and the Veltrix changes deployed. The Veltrix half is verified against the local Veltrix
  by the check script, and the LiveSell half by the e2e suite with a fake provider. No real message was sent.
- **Meta signature check in Veltrix:** done (Veltrix migration 176, `tools/whatsapp_meta_signature_check.php` 15/15). The platform number must have its Meta app secret set (see "Needs your attention" #3).
- **Not built:**
  - **§15 "customer support notifications" and "AI automated support":** the Veltrix AI agent is deliberately silent
    while forwarding is on. LiveSell answers HELP/STATUS itself and doesn't hand chats to a person or an AI.
  - **§15 customer and address verification:** Veltrix Verify is used only for business checks (Phase 8).
  - **Variant choice by colour name in WhatsApp:** works when the reply matches the option label exactly; otherwise
    the customer replies with the number.
- **SMS opt-out** (`customers.sms_opt_out`) is honoured when sending, but nothing sets it yet. Inbound SMS replies
  don't reach LiveSell; sellers can't edit it either.
- **Messages carry the private order link,** so the stored message payload contains it. Only that store's staff can
  read it, and they can already see the order.
