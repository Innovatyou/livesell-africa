# Phase 1 report — architecture, schema, auth, multi-tenancy

## Implemented

- **Schema**: 45 tables / 30 enums covering every domain in the brief (section 22), so later phases add
  logic, not tables. UUID keys, BIGINT kobo money, per-tenant uniques and indexes.
- **Migrations**: `20261105000000_init` (DDL) and `20261105000100_integrity_checks` (CHECK constraints,
  balanced-ledger trigger, append-only ledger/audit).
- **Auth**: register (user + workspace + 4 system roles + owner + storefront + channels + 14-day trial),
  login (argon2id, timing-safe on unknown emails), refresh rotation with reuse detection, logout,
  logout-all, email verification, password reset.
- **Multi-tenancy**: TenantGuard + tenant-scoped Prisma client (see ARCHITECTURE.md).
- **RBAC**: 25 permissions; Owner, Store manager, Sales assistant, Live moderator (section 5).
- **Platform**: zod env validation, Helmet, CORS allow-list, strict DTO validation, rate limiting,
  audit log with redaction, AES-256-GCM field encryption, health checks, Swagger, Docker, Nginx.

## Tests — 34 passing

- Unit (13): tenant-scope injection/overrides/rejections, model-registry sync, encryption + tamper + AAD
  binding, audit redaction, role permission boundaries.
- E2E (21, real Postgres 16 + Redis): registration bootstrap; duplicate/reserved/invalid input;
  single-use verification; login enumeration safety; refresh rotation and family revocation on replay;
  concurrent refresh race; mobile token delivery; logout; password reset; immediate suspension;
  token tampering; **cross-tenant access blocked at HTTP and query layer**; suspended workspace;
  sales-assistant permission limits; disabled members; audit redaction; **inventory oversell
  constraint, unbalanced ledger rejection, append-only ledger, duplicate-webhook rejection**; health.

Compiled build (`dist/`) was booted and smoke-tested: health, route table, security headers.

## Verify on your machine (one step)

The build sandbox blocked Prisma's engine-binary download, so `migration.sql` for the init migration
was generated from Prisma's DMMF using Prisma's naming conventions, then applied to a real Postgres
16 and exercised by the e2e suite. Confirm zero drift where you have normal network access:

```bash
cd apps/api
npx prisma migrate deploy        # on a fresh database
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

Empty output = identical. If it prints anything, replace the init migration with
`npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` (keep the
integrity-checks migration as is).

## Not yet built (by design — later phases)

- Frontend (Phase 2). Email/SMS delivery is behind an `AuthMailer` port that logs in dev; Veltrix
  adapter lands in Phase 8. Staff invitations flow, MFA enrolment, phone OTP: tables exist, endpoints
  in Phase 2. Rate limiter is in-memory; switch to Redis storage before running >1 API instance.

## Needed from you before later phases

- **Veltrix API docs + sandbox credentials** (Phase 8) — I won't invent endpoints.
- **Bachs sandbox account** (Phase 6) and whether its Connect/subaccount features are approved for you.
- Paystack/Flutterwave test keys (Phase 5–6).
