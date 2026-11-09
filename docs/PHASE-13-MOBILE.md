# Mobile phase report — LiveSell seller app (React Native)

This is the planned phase after Phase 10/12: a React Native + TypeScript seller app (`apps/mobile`) on the same
`/api/v1`. It focuses on what a seller does away from a laptop: running a live, recording orders, confirming transfers,
dispatching, and checking the day.

## Status

| Check | Result |
|---|---|
| `tsc --noEmit` (strict) | clean |
| Unit tests (jest-expo) | **8 / 8**: session client (mobile login, secure storage, single shared refresh, rotation, sign-out on a rejected refresh, server error codes, offline) and money/phone/hold formatting |
| `expo export` iOS + Android bundles | ok (Hermes bytecode, 2.6 MB each) |
| `expo-doctor` | 20 / 20 |
| API, web suites | unchanged; no API changes were needed |
| **On-device testing** | **not done here**: no simulator or device on this machine. Run `npx expo start` with Expo Go, or an EAS development build |

## Stack

- **Expo SDK 58**, React Native 0.88, React 19.3, TypeScript strict, Expo Router (`src/app/`).
- **`expo` is pinned to 58.0.19**, a release at least two weeks old; `expo.install.exclude` keeps `expo install` from
  bumping it.
- Other packages are at the versions `npx expo install` chose for SDK 58.
- **It isn't an npm workspace member.** The root `workspaces` list is now `apps/api` and `apps/web`, so React Native's
  exact React pin can't clash with the web app. The app has its own lockfile and `node_modules`.

## Security and sessions

- The app uses the API's existing mobile mode (`X-Client-Type: mobile`): the refresh token comes back in the response
  body, and is **rotated on every refresh** with reuse detection on the server.
- **Refresh token storage:** `expo-secure-store` (iOS Keychain, Android Keystore), with
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` and Android backup excluded through the config plugin.
- **Access token:** in memory only.
- **Requests:** no cookies (`credentials: 'omit'`). A 401 triggers one refresh shared by concurrent calls, then one
  retry; a rejected refresh signs out.
- **Permissions:** the same RBAC as the web. Tabs and actions are hidden without the permission, and the API enforces
  it anyway.

## Screens

| Screen | What it does |
|---|---|
| Sign in | Email and password, with clear errors; the session resumes on app start |
| Today | §7 dashboard: sales today and this month, awaiting payment, to fulfil, paid orders, average order, top products, recent payments. Pull to refresh |
| Orders | Views (awaiting payment, to fulfil, delivered, cancelled), search, status, stock-hold countdown |
| Order | Items and totals; call or WhatsApp the customer. **Confirm a bank transfer** by entering the amount received (exact-amount rule on the server), or mark it not found. Payment reminder; **out for delivery / delivered / collected** (delivery records + customer messages); confirm, process or cancel by the order rules |
| Live | Upcoming and recent sessions, with orders and paid revenue |
| Live console | Go live / end live. **Record orders by product code** (tap a product to fill its code), with a variant picker when the code has several. Prices come from the server and stock is reserved at once; the order opens in one tap |
| Stock | Active products with stock left (sold out / low), search by name or code |
| More | Account, store switcher, a link to the web app for everything else, sign out |

Every screen has loading, empty, error and success states.

## Build and release

- **Development:** `cd apps/mobile && npm install && npx expo start`. Set `EXPO_PUBLIC_API_URL` to your machine's LAN
  address (`.env.example`).
- **Builds:** `eas.json` has development, preview (internal, staging API) and production (store, production API)
  profiles:
  ```
  npx eas-cli@latest build --profile preview
  ```
  Then `eas submit`. You need an Expo account and Apple/Google developer accounts.
- **App IDs:** `africa.livesell.seller` (iOS bundle id and Android package). Change these before the first store
  build if you want different ones.
- **CI:** a new `mobile` job in `.github/workflows/ci.yml` runs types, tests, doctor and both bundles.

## Not built or blocked

- **Push notifications** (new order, transfer reported): need APNs and FCM credentials plus a device-token endpoint in
  the API. This is the next mobile step.
- **On the web only:** product editing, photos, sign-up, payment/delivery/billing settings, analytics, messaging
  settings.
- **Offline queue** for recording orders during a weak connection: not built. The app shows the error and keeps the
  form filled.
- **App icon, splash and store listing:** template assets are in place and need the LiveSell artwork.


---

# Mobile round 2 (2026-11-08): push, full seller app, offline orders, branding

## Status

| Check | Result |
|---|---|
| Mobile `tsc` | clean |
| Mobile jest | **12 / 12**: + offline queue, notification routing |
| `expo export` iOS + Android | ok |
| `expo-doctor` | 20 / 20 |
| API unit | **128 / 128** (+ push rules) |
| API e2e | **216 / 216** (+5 in `test/mobile.e2e-spec.ts`); the 4 opt-in live-Veltrix tests are skipped |

**Not done here:**
- the Firebase service account (FCM v1) and APNs keys are not uploaded;
- `eas init` has not been run;
- no build has been tested on a device.

So **no real push notification has been sent yet** (see DEPLOYMENT.md → Mobile app).

## App IDs

Both stores use `africa.livesell.seller`. It matches the package in your `google-services.json` (Firebase project
`africa-livesell-seller`).

`google-services.json` is in `apps/mobile/` and git-ignored. The dynamic `app.config.ts` reads it from the
`GOOGLE_SERVICES_JSON` EAS file variable in cloud builds.

## Push notifications

**API** (`src/push/`):
- `PushProvider` port with an Expo push service adapter (FCM/APNs credentials stay in EAS; the API stores no push
  secrets).
- Device registration endpoints: `GET`, `POST` and `DELETE /me/devices` (Expo token format validated).
  - Registration is per user, not per store.
  - A phone that changes hands moves to the new user.
- Triggered from the order outbox, so each event pushes exactly once:

  | Event | Who gets it |
  |---|---|
  | **New order** from the online store or WhatsApp | members with `orders:read` |
  | **Bank transfer reported** by a customer | members with `payments:verify_transfer` |

  Staff-entered orders don't push.
- Phones reported as `DeviceNotRegistered` are switched off immediately (tickets) or from receipts (job every 15
  minutes).
- Off by default (`PUSH_ENABLED`). A push failure never blocks an order.

**App:**
- A "Notifications on this phone" switch: Android channel `orders`, permission request, Expo push token, registration.
- Signing out unregisters the phone.
- Tapping a notification opens the order, switching to the right store first.

## Offline order recording

- **Every order the live console records carries a `clientRef`.** The API (new `orders.client_ref`, unique per store)
  returns the existing order when the same ref arrives again, even for two concurrent sends. A retry can never create a
  duplicate.
- **When the network fails or the server errors,** the order is saved on the phone (AsyncStorage: order details only,
  never tokens).
  - It is sent automatically every 20 s on the live screen, and when the app returns to the foreground.
  - A "waiting to send" list offers "Send now".
- **Orders the server refuses** (sold out, unknown code) stay in the list with the reason for the seller to discard.
  They are never retried silently.

## Moved from web-only into the app

| Area | In the app |
|---|---|
| Sign-up | Create a store (same fields and rules as the web, terms/privacy links); the trial starts and the user is signed in |
| Products | Add a product (photo, name, code, price, stock, visibility); edit name, code, price, description, visibility and photos; **add or remove stock** per variant. Products with options keep their per-option prices on the web |
| Photos | Image picker, then a presigned upload straight to S3/R2 (type and size checked, ≤ 5 MB) |
| Settings | Store details (name, about, WhatsApp, phone); automatic customer messages on/off; **delivery**: pickup, zones (add), your couriers (add) |
| Analytics | 7 / 30 / 90 days: sales, net, orders, average order, completion, new customers, channels, live sessions (conversion only with recorded viewers), top products. Plan-gated like the web |
| Billing | Plan and trial, commission this month / not invoiced, open invoices with **Pay now** (opens the secure checkout; the invoice is marked paid only after server verification), overdue warning |

**Still on the web:**
- payment gateway keys, team and roles, business verification;
- per-message channel choices, plan changes;
- products with options (creating variants), CSV import, admin.

## Branding

- **Generated artwork** (`apps/mobile/assets/`, LiveSell green `#0e7a4d`): a shopping bag with a "live" play mark.
  - app icon, Android adaptive icon (foreground / background / monochrome);
  - splash on green;
  - Android notification icon (white silhouette); favicon.
- **Splash:** configured with `expo-splash-screen`.
- **Store listing copy:** `docs/STORE-LISTING.md` (name, descriptions, keywords, screenshots to capture, privacy
  labels, review notes).
- Replace the artwork with a designer's version whenever you have one; the file names stay the same.

## Files

**API:**
- new: `src/push/{push-provider,push.service,push.controller,push.module,push.spec}.ts`
- new: migration `20261110090000_mobile_push`
- new: `test/mobile.e2e-spec.ts`
- changed: `prisma/schema.prisma`, `src/config/env.ts`, `src/app.module.ts`, `src/orders/{orders.dto,orders.service}.ts`
- changed: `src/automation/{order-notifier.service,automation.jobs}.ts`

**Mobile:**
- new: `app.config.ts`, `src/lib/{push,offline-queue,offline-queue.test}.ts`
- new: `src/app/{signup,analytics,billing}.tsx`, `src/app/products/[id].tsx`, `src/app/settings/{store,delivery}.tsx`
- changed: `app.json`, `src/lib/{api,auth}.tsx?`, `src/app/_layout.tsx`, `src/app/login.tsx`
- changed: `src/app/(tabs)/{products,more}.tsx`, `src/app/live/[id].tsx`
- regenerated: assets

**Docs:** `docs/STORE-LISTING.md`, `docs/DEPLOYMENT.md` (mobile section), `.env.example`.
