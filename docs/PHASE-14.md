# Phase 14: everything in the app, pre-orders, smart codes, more staff roles, Kwik assessment

## Status

| Check | Result |
|---|---|
| API unit | 129 / 129 (+ new roles stay narrow; smarter product codes) |
| API e2e | **221 / 221** (+4 in `test/phase14.e2e-spec.ts`); 4 opt-in live-Veltrix tests skipped |
| Mobile `tsc`, jest, `expo-doctor`, Android bundle | clean, 14 / 14, 20 / 20, ok |
| Web `tsc`, vitest, `next build` | clean, 31 / 31, ok |
| **On a device** | not yet: needs a new build (new native modules: date/time picker, document picker) |

## Does LiveSell stream to TikTok?

No.
- LiveSell doesn't stream video and doesn't show the live on TikTok.
- The seller goes live in the TikTok / Instagram / Facebook app as usual.
- A LiveSell live session is the **sales record** of that live: products shown, live-only prices, the orders recorded
  from comments, and the report.
- TikTok's official APIs don't give third-party apps live comments, so orders are recorded by product code (rule 10).

## Everything in the app (no web needed)

| New / changed screen | What it does |
|---|---|
| **Live → New live session** | Platform (TikTok, Instagram, Facebook, YouTube, WhatsApp, other), optional handle, title, **Go live now** or schedule (date/time picker), how viewers order, optional products with live-only prices. The sales channel is created on first use |
| **More → Team & roles** | Invite by email with a role, change role, remove / restore access (with confirmation), resend or cancel invitations; plan seat limit explained |
| **More → Payments & bank accounts** | Connect Paystack / Flutterwave / Bachs with your own keys, or get paid through LiveSell to your bank (searchable bank list, name check); make default, on/off; transfer accounts: add, default, on/off, remove |
| **More → Customer messages** | Per message: WhatsApp / SMS / email; reminder timing |
| **Plan & billing** | Change plan (monthly / yearly), scheduled changes shown, invoice created when payment is needed |
| **Products** | Code filled in from the name as you type; options (e.g. Size × Colour, up to 100 combinations) with stock per combination; prices per option on existing products |
| **Business verification** | Certificate as a photo **or a PDF** |
| **Store settings** | Pre-order switch (below) |

Still easier on the web, but nothing requires it:
- CSV import / export;
- printable invoices;
- the platform admin.

## Pre-orders (selling beyond stock)

The store setting is **"Sell beyond stock (pre-orders)"** (`storefront_settings.allow_preorders`, off by default).

**With it on:**
- An order **holds the stock that exists**. The rest of each line is recorded as `order_items.backordered_qty`.
  - A DB CHECK keeps it between 0 and the line's quantity.
  - `reserved ≤ on_hand` is never broken: no negative stock.
- **Restocking fills waiting orders oldest first.** This applies to a stock add, receive, count or CSV import, and also
  to stock freed by a cancelled, expired or refunded order.
  - It happens in the same transaction, under the inventory row lock (`InventoryService.allocateBackordersTx`).
- **Dispatch is blocked** while anything is awaiting stock: `409 AWAITING_STOCK`.
- **Cancel, expiry and refund release only what the order actually holds** (`held()`), so they can't take another
  order's stock.
- **Storefront:** items show "Pre-order" (`availability: 'preorder'`) and can be added to the cart.
- **WhatsApp ordering** accepts them too.
- **Order screens** (web and app) show "Pre-order: N awaiting stock".

**With it off:** behaviour is unchanged. Orders beyond stock get `409 INSUFFICIENT_STOCK`.

## Smart product codes

`codePrefix()` picks the **head noun** of the name:
- It skips colours, sizes, materials, marketing words and containers ("Set of 3 Wigs" → WIG).
- It maps about 100 common items to the codes sellers already say on live:
  - Handbag → BAG
  - Earbuds → BUDS
  - Perfume → PERF
- Otherwise it uses the noun's first 5 letters.
- The category is used only when the name gives nothing.

Examples: "Red Leather Handbag" → BAG001, "Ladies Block Heels Size 39" → HEEL002.

Numbers never repeat across prefixes. Web and app fill the code from the name until the seller types their own.

## Staff roles

| Role | Can | Can't |
|---|---|---|
| Business owner | everything | — |
| Store manager | products, stock, orders, customers, live, delivery, reports, confirm transfers | staff, gateways, refunds, plan |
| Sales assistant | record and move orders, check stock | money, settings |
| Live moderator | create / run lives, record orders | money, settings |
| **Dispatch & delivery** (new) | move orders, deliveries, couriers | payments, staff, settings |
| **Accounts** (new) | payments, confirm transfers, reports | stock, staff, settings, refunds |
| **Customer care** (new) | orders, customer notes | money, settings, exports |

- Existing stores get the new roles automatically at API start (`RbacService.addMissingSystemRoles`, idempotent).
- Any number of staff, up to the plan's seat limit.
- Every route is enforced server-side by permission.

## Kwik Delivery: can it be integrated?

**Yes, technically**, as a new `LogisticsProvider` adapter next to the manual one. **It's blocked on Kwik, not on
code.** From Kwik's Apiary docs (blueprint updated 2024-12-22):

| Area | What the docs say | Impact |
|---|---|---|
| Auth | `POST /vendor_login` (email, password, `domain_name`) → `access_token`, sent in the body or query of each call | Store per-seller (or platform) credentials encrypted; token expiry isn't documented, so re-login on failure |
| Price | `POST /send_payment_for_task` (pickups / deliveries / vehicle), `POST /get_bill_breakdown` | Quote before booking. **No currency field is documented** |
| Book | `POST /v2/create_task_via_vendor`: pickup and delivery name / phone / **address + latitude/longitude**, vehicle, `payment_method`, `is_cod_job` | **Needs coordinates.** LiveSell stores text addresses, so a geocoder (e.g. Google Maps) is needed first |
| Track | `GET /getJobStatus` (plain-text reply), `GET /view_task_by_relationship_id`; statuses 0–10 (UPCOMING … ENDED, FAILED, CANCEL) | Poll from a job; map to our delivery statuses |
| Cancel | `POST /cancel_vendor_task` with `job_status` 9 (the docs contradict themselves here) | Must be confirmed with Kwik |
| Webhooks | **Not documented** | Polling only |
| Payment | Wallet / card / end-of-month codes, some unlabelled | Pick the model with Kwik (prepaid wallet is the simplest) |
| Hosts | **Only a staging host is documented**; no production URL, no sandbox sign-up | Kwik must give API access |

**What we need from Kwik:**
1. Sandbox and production API access for a business account.
2. The production base URL.
3. Confirmation of the cancel code, the payment method codes, currency, and token expiry.
4. Whether webhooks exist.

**What we need on our side:**
1. A geocoding key so addresses get coordinates.

Then the adapter is about one phase of work, and it stays feature-flagged off until a sandbox test passes (rule 6).
Until then, sellers use their own riders or couriers (already built).

## Files

**API:**
- migration `20261111090000_preorders`
- `src/inventory/inventory.service.ts`: shortfall, allocation, held-only release
- `src/orders/orders.service.ts`: `reserveForOrderTx`, dispatch guard, `held()`
- `src/storefront/storefront-public.service.ts`
- `src/automation/whatsapp-commerce.service.ts`
- `src/onboarding/*`: `allowPreorders`
- `src/catalog/catalog-utils.ts`: `codePrefix`
- `src/rbac/*`, `src/staff/staff.dto.ts`
- `test/phase14.e2e-spec.ts`

**Web:**
- store pages: pre-order label
- order detail badge
- store settings: pre-order card
- product form: auto code
- team roles

**Mobile:**
- new: `live/new.tsx`, `team.tsx`, `settings/payments.tsx`, `settings/messages.tsx`
- changed: `billing.tsx` (plans), `products/[id].tsx` (auto code, options, option prices), `verification.tsx` (PDF),
  `settings/store.tsx`, `orders/[id].tsx`, Live and More tabs
- deps: `@react-native-community/datetimepicker`, `expo-document-picker`

---

# Round 2 (2026-11-10): modern app UI and LiveSell Academy

## Status

| Check | Result |
|---|---|
| Mobile `tsc` | clean |
| Mobile jest | **17 / 17** (+ Academy content and progress) |
| `expo-doctor` | 20 / 20 |
| Android bundle | ok |
| On a device | not yet. A new build is needed for the new native modules: linear gradient, haptics, fonts |

## Design system (`src/components/ui.tsx`)

**New components:**
- Ionicons icons, `IconBadge`, `Avatar` (initials);
- `ListRow` (icon / title / subtitle / right side / chevron);
- `StatTile`;
- `Hero`: brand gradient header, white on deep green, readable in both themes;
- `SearchBar` with clear;
- `Chips` (filter tabs), `SectionTitle`, `Progress`.

**Upgraded components:**
- `Button`: optional icon, light haptic tap, softer radius.
- `Notice`: icon per tone; `role=alert` for errors.
- `Empty`: icon and an optional call to action.

**Navigation:**
- Tab bar with filled / outline Ionicons and bold labels.
- Headers flat on the canvas colour.

## Screens

| Screen | What's new |
|---|---|
| **Today** | Greeting hero with sales today and this month. Quick actions: Go live, Add product, Orders, Learn. Icon stat tiles (awaiting payment and to fulfil open the filtered orders). Academy progress card. Ranked top products. Payment rows with status icons |
| **Orders** | Search bar. Filter chips. Rows with customer initials, reference, live session, hold time, amount and status. Empty state offers to start a live |
| **Stock** | Search. Chips: All / Running low / Sold out (new server-side `stock` filter in the query). Stock-coloured icons |
| **Live** | "You're live" hero with a button to the console. Platform icons (TikTok, Instagram, Facebook, YouTube, WhatsApp). Empty state links to the Academy |
| **More** | Profile hero. Settings grouped: Learn, Store, Money, Team, App. Each row has an icon and a one-line hint. Notifications and biometric switches under "This phone" |

Every other screen picks up the new buttons, notices and empty states automatically.

## LiveSell Academy (More → Learn, Today, Live)

**Screens:**
- `learn/index.tsx`: course overview, overall and per-track progress, "Continue" to the next lesson.
- `learn/[id].tsx`: a lesson. The quick-check question must be answered correctly before the lesson can be marked complete; then it moves on to the next lesson.

**Lesson layout:** summary, numbered steps, pro tips, "Avoid", a quick check, and "Do it now in LiveSell" buttons that
open the matching screen (add product, payments, delivery, new live, orders awaiting payment, team, analytics,
verification).

**Content** (`src/content/academy.ts`): 15 lessons in 6 tracks.

| Track | Lessons |
|---|---|
| Start here | How live selling works; first 5 products; get paid safely; delivery |
| TikTok Live | Access; setup; running a live that sells; after the live |
| Instagram Live | Going live; stories / DMs / link in bio |
| Facebook Live | Pages and groups |
| WhatsApp | Business, Status, order-by-code |
| Grow | Trust; pricing and flash deals; add a helper; read your numbers |

- **Platform rules are hedged.** TikTok LIVE eligibility (age, followers) is described as "check in the app", with no
  promised numbers or results. The screen says LiveSell isn't affiliated with these platforms.
- **Progress** is saved on the phone (`src/lib/academy-progress.ts`). Unknown ids are ignored.
- **Tests** check unique ids, valid quiz answers, and that every "Do it now" link points to a screen that exists.

## Not done

- The web app keeps its current design: tokens, dark mode and the 3D landing hero. The Academy is app-only for now. It
  can be added to the web from the same content.
