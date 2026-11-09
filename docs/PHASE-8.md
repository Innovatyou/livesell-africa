# Phase 8 report — Veltrix integration

Scope: MASTER-SPEC §28 Phase 8, covering §15 (Veltrix messaging and verification, messaging usage and billing, an
integration settings page) and §26 #10 ("Veltrix notification fails"). Automated WhatsApp ordering and order/payment
notifications are Phase 9; this phase builds the layer they will use.

The Veltrix source (`C:\laragon\www\mailwizz-yii3`) was the reference for every endpoint, field and status code. I made
small, purely additive changes there (see "Changes in the Veltrix project").

## Status at a glance

| Check | Result |
|---|---|
| API unit tests | **91 / 91**: 75 earlier + 16 new (Veltrix adapters with mocked `fetch`, templates, helpers) |
| API e2e | **171 / 171**: 159 earlier + **12 Phase 8**. **+4 live tests against the running Veltrix**, opt-in, passed |
| Web tests (Vitest) | **22 / 22** |
| `tsc --noEmit`, `nest build`, `next build` | clean |
| Drift check after the new migrations | empty |
| Veltrix side | new check script **17 / 17** (incl. the real HTTP stack); existing PHPUnit 4 / 4; all changed files lint clean |
| Live smoke test (LiveSell API ↔ local Veltrix, temporary key, nothing sent) | admin page showed the real Veltrix account and wallet; a WhatsApp test to a non-existent server was refused and recorded as failed; email "not configured" recorded; sign-up still worked; no key in logs. The temporary key was deleted afterwards |

## Needs your attention

1. **Credentials for the platform Veltrix account.** Nothing is sent until these are set on the API server
   (`VELTRIX_ENABLED=true`):
   - `VELTRIX_BASE_URL` (site root) and `VELTRIX_API_KEY` (a customer API key of LiveSell's account);
   - `VELTRIX_SMS_SENDER`, an **approved** sender ID on that account;
   - `VELTRIX_EMAIL_FROM`, ideally on a **verified sending domain** in Veltrix so mail is DKIM-signed;
   - `VELTRIX_WHATSAPP_SERVER_UID`, the WhatsApp number LiveSell sends from;
   - `VELTRIX_VERIFY_KEY`: a Verify partner credential (`<key_id>.<secret>`) with the `business` scope and an active
     Verify subscription, for automated CAC checks.
2. **Deploy the Veltrix-side changes** (below) before switching LiveSell on. Without them a retry after a timeout
   could send an SMS or WhatsApp message twice, and SMS delivery can't be tracked.
3. **Placeholders to confirm:**
   - **Prices charged to sellers per message:** SMS ₦4, WhatsApp ₦6, email free.
   - **Monthly limits per seller:** SMS 300, WhatsApp 500, email 2,000.
   - Both are editable on the admin page, and plans can carry their own limits (`limits.messaging`).
   - Seller messaging cost is **recorded**, not yet invoiced. It could be added to the LiveSell invoice, like
     commission.
4. **WhatsApp templates.** Business-initiated WhatsApp messages need templates approved by Meta on the platform
   number. Phase 9 will register the order templates (order confirmation, payment reminder, dispatch…). For now
   WhatsApp is used for free text only (admin test send).
5. **The Verify check is advice only.** It never approves anything; a person still decides. It currently runs only for
   CAC RC/BN numbers, not "OTHER".

## What was built (LiveSell)

### Ports and Veltrix adapters (`src/messaging/`)

- **`MessagingProvider`:** email, SMS, WhatsApp (text or approved template), SMS delivery receipt, and status
  (account, wallet, channels).
- **`VerificationProvider`:** CAC/TIN registry check.
- **`VeltrixMessagingAdapter`:**
  - **Endpoints:** `POST /transactional-emails`, `POST /sms-tools/quick-send`, `POST /whatsapp/send`,
    `GET /sms-tools/logs?message_id=`, `GET /profile`, `GET /wallet`. Auth is `X-MW-PUBLIC-KEY`, and every send
    carries an `Idempotency-Key`.
  - **Not retried** (a definite refusal): 402 (wallet empty), 403 (channel off), 404, 422, 401.
  - **Retried:** 409 (same key still running), 429, 5xx and network errors.
  - **Failed emails:** an email Veltrix tried and failed (500 with the record marked `error`) counts as a
    *definite* failure, so the retry uses a new key and doesn't just get the same failure back.
  - **Template values:** a `|` inside a value can't break the WhatsApp template.
- **`VeltrixVerifyAdapter`:** `POST /api/verify/v1/kyc/business` with `Bearer <key_id>.<secret>`. The result is mapped
  to VERIFIED, MISMATCH, NOT_FOUND, ERROR or PENDING, with match score and registered name.
- **Inert when off.** While `VELTRIX_ENABLED=false` the adapters attempt nothing, and the auth and billing ports stay on
  the development log adapters, exactly as before.

### Notification service (`src/notifications/`)

- **One row per message** (`notifications`): type, channel, destination, status, attempts, provider message id, sent
  and delivered times.
- **Exactly-once sending.**
  - The idempotency key is `ls-<id>-<seq>`.
  - After an ambiguous failure (timeout, 409) the retry reuses the same key, so Veltrix replays instead of sending
    again.
  - After a definite failure the sequence moves on.
  - Repeated business events are dropped by a unique `dedupe_key` (e.g. `order:<id>:paid:sms`, used from Phase 9).
- **§26 #10, failures never break the flow:**
  - Temporary failures retry at 1 min, 5 min, 25 min and 2 h. The job runs every minute and leases each row so only one
    worker sends it.
  - After 5 attempts the row is **FAILED**, visible to admins with "Send again".
  - Sign-up, password reset and billing all carry on when Veltrix is down.
  - The OTP is the one exception: the person is waiting for it, so they're told "couldn't send the code, try again".
- **Secrets are never stored.** OTP codes and the verification, password-reset and invitation links are rendered in
  memory and sent once. Their rows keep an empty payload and are not retryable, so the person simply asks again.
- **Usage, pricing and limits (§15):**
  - Every message sent for a seller gets a `notification_usage` row: seller, channel, cost (from the admin price),
    billing month (Lagos time).
  - Monthly limits per channel are checked before sending. Hitting one is recorded ("Monthly limit reached") and
    audited.
  - Auth and LiveSell-billing messages are platform cost, never charged to a seller.
  - SMS delivery receipts are polled every 10 minutes (SENT → DELIVERED / FAILED).
- **Templates.** A branded HTML email layout plus SMS texts for:
  - email verification;
  - password reset;
  - staff invitation;
  - phone OTP;
  - trial/renewal reminder;
  - payment overdue;
  - subscription ended;
  - test message.

  Every value is HTML-escaped, and links are built only from `APP_URL`.
- **Veltrix `AuthMailer` and `BillingNotifier`.** These are the Phase 2 ports, now delivered through Veltrix when
  enabled.

### Business verification (Veltrix Verify)

- When a seller submits a CAC RC/BN number, LiveSell runs a registry check against the registered name. The result
  (status, match score, name on the register) is stored on the request for the reviewer.
- Admins can re-run it with `POST /admin/business-verifications/:id/registry-check`.
- A Verify outage is recorded as "UNAVAILABLE" and never blocks the submission. Approval is always a person's
  decision.

### Screens

- **Platform admin → Integrations** (`/admin/integrations`, new admin area for LiveSell staff only). This is the §15
  "dedicated integration settings page":
  - Veltrix connection: account, wallet balance, channels, Verify;
  - a test send;
  - prices and seller limits;
  - seller usage this month;
  - failed messages with "Send again".

  Platform staff see a "Platform admin" link in the app.
- **Settings → Messaging** (sellers, `reports:read`):
  - this month's WhatsApp, SMS and email use against the limits, with a usage bar;
  - cost;
  - recent messages, with destinations masked and failure reasons in plain words.

## Changes in the Veltrix project (`C:\laragon\www\mailwizz-yii3`)

All of these are additive. Existing clients (the mobile app, the web) see no change unless they send the new header.

| Change | Files |
|---|---|
| Optional `Idempotency-Key` on `POST /transactional-emails`, `/sms-tools/quick-send`, `/whatsapp/send`. Same scheme as the Verify partner API. First response stored 24 h and replayed with `Idempotent-Replayed: true`. Same key with a different body → 422; still running → 409 | `src/Common/Middleware/ApiIdempotencyMiddleware.php`, `src/Common/Service/Api/ApiIdempotencyService.php`, `migrations/174_api_idempotency.sql`, `config/api/routes.php` |
| Quick-send returns per-recipient `results` (`recipient, status, message_id, error`) | `src/Api/Controller/SmsToolsController.php` |
| `GET /sms-tools/logs?message_id=…` looks up one message's delivery receipt | same |
| Expired idempotency keys pruned by the daily maintenance (`prune/pending-delete`) | `src/Console/Command/PrunePendingDeleteCommand.php` |
| Documented the previously undocumented one-off endpoints (`/sms-tools/*`, `/whatsapp/senders`, `/whatsapp/send`) and the header | `docs/API.md` |
| Check script | `tools/api_idempotency_check.php` (17 checks, incl. real HTTP; cleans up after itself) |

- **Applied locally.** Migration 174 is applied to the local Veltrix database.
- **Not committed.** Nothing was committed in either repository.
- **Deploying:** run `php tools/run_sql_migration.php migrations/174_api_idempotency.sql` on the server, then deploy
  the code.

## Schema changes (LiveSell)

- `20261106200000_phase8_notifications_veltrix`:
  - **`notifications`:**
    - `dedupe_key` (unique);
    - `retryable`;
    - `next_attempt_at`, `sent_at`, `delivered_at`.
  - **`business_verifications`:** `automated_check`, `automated_checked_at`.
  - **Checks:** non-negative cost, `YYYY-MM` billing period, non-negative attempts.
- `20261106200100_phase8_notification_key_seq`: `notifications.provider_key_seq`.
- New platform settings (defaults): `messaging.price_kobo`, `messaging.monthly_limits`.

## Tests added

- **Unit:**
  - **Veltrix adapter:**
    - channels off → nothing attempted;
    - email/SMS/WhatsApp request fields, API key and idempotency key;
    - quick-send result mapping;
    - wallet, channel-off and bad-key refusals;
    - outages and 409 treated as temporary;
    - definite vs ambiguous email failure;
    - template value escaping;
    - delivery receipt mapping (found a real bug: "undelivered" was read as "delivered");
    - status without secrets.
  - **Verify adapter:** auth, fields and every status.
  - **Templates:** HTML escaping, token-safe links, OTP within one SMS segment, exact naira amounts.
  - **Helpers:** phone/email normalisation, masking, Lagos billing month.
- **E2E (`test/phase8.e2e-spec.ts`, 12 tests, fake Veltrix, the real Veltrix mailers):**
  - **Sign-up email:** sent once, the link works, the token isn't stored, not charged to the seller.
  - **Veltrix down:** sign-up and reset still work; secret messages are failed, not retried.
  - **Phone OTP:** code arrives and verifies; a refused send or missing SMS channel says so honestly.
  - **Staff invitation link** works.
  - **§26 #10:**
    - a billing email is retried on schedule, same key after ambiguous failures and a new key after a definite one;
    - FAILED after 5 attempts and never sent twice;
    - an admin "Send again" works;
    - a message that comes through is sent exactly once even with three workers racing;
    - wallet empty or channel off is recorded with the reason.
  - **Usage:**
    - admin price and limit validation;
    - repeated events deduped;
    - limit stops sending and is audited;
    - cost recorded per message;
    - seller usage report and masked list;
    - permissions;
    - another seller sees nothing (§26 #9);
    - platform usage report.
  - **Delivery receipts:** SENT → DELIVERED / FAILED.
  - **Admin integration endpoints:** status without secrets, test send, bad channel refused, seller refused, secret
    messages can't be re-sent.
  - **Business verification:** CAC check stored for the reviewer and re-runnable; never approves; an outage doesn't
    block the submission.
- **Live (`test/veltrix-local.e2e-spec.ts`, 4 tests, opt-in with `TEST_VELTRIX_BASE_URL` + `TEST_VELTRIX_API_KEY`,
  never sends a message):**
  - real account and wallet;
  - refused send mapped as permanent, and the same key replays the first answer;
  - different body under the same key → refused;
  - delivery lookup by message id;
  - wrong key refused.

  Ran against the local Veltrix with a temporary key, which was deleted afterwards.
- **Web:** failure-reason wording, limit percentages.

## Files

**New (API):**
- `src/messaging/{messaging-provider,veltrix.adapter,veltrix.adapter.spec}.ts`
- `src/notifications/{notifications.service,notifications.controller,notifications.module,notifications.jobs,templates,veltrix-mailers,notifications.spec}.ts`
- the two migrations above
- `test/{phase8,veltrix-local}.e2e-spec.ts`

**Changed (API):**
- `src/auth/auth.module.ts`, `src/billing/billing.module.ts`: Veltrix adapters bound when enabled.
- `src/onboarding/{onboarding.service,onboarding.controller}.ts`: registry check.
- `src/app.module.ts`, `src/config/env.ts`, `prisma/{schema.prisma,seed.ts}`, `.env.example`.
- `test/{env.js,support.ts}`: fake messaging and verification providers.

**New (web):**
- `src/app/admin/{layout,integrations/page}.tsx`
- `src/app/(app)/settings/messaging/page.tsx`
- `src/lib/{messaging-labels,messaging-labels.test}.ts`

**Changed (web):** `src/components/app-shell.tsx`, `src/lib/{types,use-api}.ts`.

**Docs:** `README.md`, `docs/ARCHITECTURE.md` ("Messaging"), `CLAUDE.md` status.

## Blocked or incomplete

1. **Real sends are untested.** Nothing has been sent through Veltrix for real: no platform credentials or sender
   ID/number were provided, and I avoided sending real messages from the local install. Everything up to the gateway
   is verified against the real Veltrix code.
2. **Order and payment notifications, and WhatsApp templates:** Phase 9 (WhatsApp commerce automation and
   notifications).
3. **Identity and address verification** (BVN/NIN, address) exist on Veltrix Verify but weren't wired. Seller KYC
   beyond the CAC check would need a product decision on when to ask for BVN/NIN (consent and cost).
4. **AI customer support** (§15 "where the Veltrix API provides it"): Veltrix has AI agent APIs. This belongs with
   WhatsApp automation in Phase 9.
5. **Seller messaging cost is recorded but not invoiced** (see above).
6. **Dev data from the smoke test:** a "Smoke 8 Shop" account and a few failed test notifications in the dev
   database. The demo user's platform role was set back to normal.

## Needed from you

- Veltrix platform credentials (item 1 above) and a WhatsApp number with approved templates.
- Confirm or change the messaging prices and limits, and say whether seller messaging cost goes on the LiveSell invoice.
- Deploy the Veltrix-side changes, or review them first; they're uncommitted in `mailwizz-yii3`.
- Go-ahead for Phase 9 (WhatsApp commerce automation and notifications).
