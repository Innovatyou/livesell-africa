# Phase 11 report — Super-admin portal

Scope: MASTER-SPEC §28 Phase 11, covering §21 (the administrator dashboard).

## Status

| Check | Result |
|---|---|
| API unit tests | 123 / 123 |
| API e2e | **205 / 205**: 201 + 4 new in `test/phase11.e2e-spec.ts`; the 4 opt-in live-Veltrix tests are skipped |
| Web tests | 29 / 29 |
| `tsc`, `nest build`, `next build` | clean |

## Who can do what

The portal lives at `/admin` and is open only to platform staff.

| Role | Can do |
|---|---|
| **PLATFORM_SUPPORT** | View everything |
| **PLATFORM_ADMIN** | Make changes |

The API enforces this on every route, and every change is audited.

## §21 checklist

**Dashboard (`GET /admin/overview`, `/admin`)**

| §21 item | Where |
|---|---|
| Total / active / inactive sellers, new registrations | sellers block, plus the 30-day signups series |
| Total orders, transaction volume | verified ORDER payments |
| SaaS subscription revenue, platform commission | platform ledger (`SUBSCRIPTION_REVENUE`, `COMMISSION_REVENUE`); commission still owed = `COMMISSION_RECEIVABLE` |
| Payment gateway performance | per provider over 30 days: started, verified, failed, abandoned, success rate |
| Messaging usage | by channel and status over 30 days |
| Subscription statistics | by status and by plan |
| Top-performing sellers | by verified sales over 30 days |
| System health | database and Redis latency, order events stuck more than 10 minutes, messages waiting for a retry (`GET /admin/health`) |
| Failed webhook events, integration errors | failed or bad-signature payment webhooks (`/admin/webhooks`), failed messages |

**Admin actions**

| §21 action | Where |
|---|---|
| Create / edit subscription plans | `/admin/plans`: prices, trial, commission rate, on/off, visibility. Uses the existing `/admin/plans` API, which can also create plans |
| Manage sellers, suspend accounts | `/admin/sellers` (search, status filter) and the seller page (plan, sales, catalogue, team, invoices, commission, recent activity). **Suspend** needs a reason and blocks the team, storefront and checkout at once; data is kept. **Reactivate** restores the store |
| Manage payment providers | `/admin/payments`: on/off, sandbox or live; shows whether the platform key and webhooks are configured |
| Configure gateway credentials | Platform keys stay in the server environment and are never shown. The page shows whether each is set |
| Configure the Veltrix integration, manage platform notifications | `/admin/integrations` (Phases 8–9): Veltrix status, test send, messaging prices and limits, failed messages with retry, WhatsApp number, templates, forwarding |
| Set commission rates | Plan commission (Plans) and `commission.default_bps` (Settings) |
| Commission collection | `/admin/payments`: commission invoices across sellers with the open total; **waive** (reason required) |
| View audit logs | `/admin/audit`: filter by store, action prefix or platform-only; metadata is already redacted |
| Configure platform settings | `/admin/settings`: commission default, invoice due days, minimum invoice, grace days, reminder days, stock holds, stale-transfer threshold. Validated, and old/new values are audited |
| Business verification queue | `/admin/verifications`: document, registry check, approve, or reject with a reason |
| Sales enquiries | on Settings, with "mark contacted" |

## Waiving a commission invoice

A waived invoice becomes `UNCOLLECTIBLE`. It still counts as billed, so it is never invoiced again.

In one transaction:
- the seller's payable and the platform's receivable are reversed (both sides balanced);
- the write-block it caused lifts.

## Files

**API:**
- new: `src/admin/{admin.service,admin.controller,admin.module}.ts`, `test/phase11.e2e-spec.ts`
- changed: `src/app.module.ts`; `src/billing/commission-billing.service.ts` (waived invoices count as billed)

**Web:**
- new: `components/admin-ui.tsx`; `app/admin/{page,sellers/page,sellers/[id]/page,plans/page,payments/page,verifications/page,audit/page,settings/page}.tsx`
- changed: `app/admin/layout.tsx` (navigation), `components/app-shell.tsx`

## Not done or limited

- **No closing or deleting accounts.** Suspension is the tool; account closure and data erasure need a legal process (NDPA), which is the customer-level erasure built in Phase 3.
- **Platform staff roles** are set in the database (`users.platform_role`). There's no UI for inviting staff.
- **Plan features and limits** are edited through the API (JSON). The page edits prices, trial, commission and visibility.
- **Revenue figures** are NGN only; there are no other currencies yet.
