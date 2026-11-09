# Phase 12 report — Security, testing and deployment

Scope: MASTER-SPEC §28 Phase 12, covering §23 (security and financial integrity), §26 (testing) and §27 (deployment).

## Status

| Check | Result |
|---|---|
| API unit tests | **127 / 127** (+4: production configuration checks, alert throttling) |
| API e2e | **211 / 211** (+6 security tests in `test/phase12.e2e-spec.ts`); the 4 opt-in live-Veltrix tests are skipped |
| Web tests | 29 / 29 |
| `tsc`, `nest build`, `next build` | clean |
| `npm audit --omit=dev` | **0 vulnerabilities** (was 2 high) |
| Backup → restore drill (local Postgres) | ok: archive verified, counts match, ledger balanced, non-empty target refused |
| Web standalone build, run locally | ok: pages, static assets, security headers |
| `docker compose config` (dev + prod) | valid |
| **Docker image builds** | **not run here: Docker Desktop fails to start on this machine.** CI builds all three images on every push |

## Security review (§23)

| Requirement | State |
|---|---|
| Secure authentication, strong hashing | argon2id (checked by test); access token in memory; refresh token in an httpOnly, `SameSite=Strict` cookie scoped to `/api/v1/auth` (test); reuse detection (Phase 1) |
| MFA-ready | Sessions and verification tokens are separate; OTP over Veltrix SMS exists (phone verification). **MFA at login is not built.** Recommended before opening to large sellers |
| RBAC, tenant isolation | Guards on every route; scoped Prisma client; `TENANT_SCOPED_MODELS` unit test; cross-tenant e2e in every phase; forged tenant header gets 403; forged JWT gets 401 (tests) |
| Encrypted gateway credentials | AES-256-GCM, tenant-bound (`CryptoService`); never returned |
| Webhook signatures, duplicate webhooks | Every provider plus Veltrix forwarding (Phases 5–9); unique `(provider, event_id)`; webhooks only trigger a verify. Meta signatures in Veltrix: migration 176 |
| Rate limiting | Nest throttler (global + auth), checkout throttles; Nginx `limit_req` on auth and API (webhooks exempt) |
| Validation, XSS, SQL injection | `whitelist` + `forbidNonWhitelisted`; money as whole-kobo strings. No `$queryRawUnsafe` anywhere (scanned); injection-shaped search returns empty (test). Email templates escape values (unit tests). CSP and other headers via helmet (test) |
| CSRF | Cookie is `SameSite=Strict`, only on `/api/v1/auth`; every other call needs a bearer header, so CSRF can't ride on cookies |
| Audit, uploads | `AuditService` on security and money actions, viewable in `/admin/audit`; presigned uploads with type/size limits and HEAD check |
| Idempotent payments, transactions, reconciliation | Phases 5–7, 10b (ledger checked in the restore drill too) |
| No card data | Card entry happens on provider-hosted checkout only; LiveSell never sees PAN/CVV |
| No private keys in the frontend | Web env has only `NEXT_PUBLIC_API_URL` |
| Errors | No stack traces in responses (test); 5xx logged as structured JSON with a request ID |

**Fixed in this phase:**
- **`multer` DoS advisory (GHSA-q7qp-rjg7-q26m).** LiveSell never parses multipart, but the package loads with Nest. It is pinned to 2.5.0 through `overrides`. `npm ls` reports the override as "invalid"; that is expected.
- **Nginx webhook rule** didn't match the real routes (`/payments/:provider/webhook/:accountId`, `/whatsapp/webhook`), so provider webhooks were rate limited. Fixed, and the stale `/socket.io` block was removed.
- **Production can no longer start with development settings** (see DEPLOYMENT.md).

## Deployment (§27)

| Item | Where |
|---|---|
| Dockerfiles | `apps/api/Dockerfile`: runtime + new `migrator` target. `apps/web/Dockerfile`: new, Next standalone, non-root, health check |
| Compose | `docker-compose.yml` (dev); `docker-compose.prod.yml` (new: api, web, nginx, `migrate` job, optional self-hosted Postgres/Redis) |
| Nginx | `infra/nginx/default.conf` (dev, fixed); `infra/nginx/prod.conf` (new: TLS 1.2/1.3, HSTS, ACME, separate app/api hosts, rate limits, Swagger blocked) |
| Environment templates, startup checks | `.env.example` (complete); `src/config/production-checks.ts` |
| Migrations, builds | `docker compose … run --rm migrate`; CI and DEPLOYMENT.md |
| Health checks | `/health/live`, `/health/ready` (database + Redis); `/admin/health` adds stuck jobs |
| Structured logging, error monitoring | JSON logs (Nest `ConsoleLogger({ json: true })`) in staging/production; `X-Request-Id`; `ErrorReportingFilter` + optional `ALERT_WEBHOOK_URL` |
| Backups | `scripts/backup.sh`, `scripts/restore.sh` |
| Documentation | `docs/DEPLOYMENT.md`: environments, secrets, first deploy, releases, rollback, backups, monitoring, go-live checklist |
| Testing | `.github/workflows/ci.yml` (audit, types, unit, e2e with Postgres/Redis/MinIO, web, images); `tools/load/storefront.k6.js` |

## Not done (needs you or production infrastructure)

- **Version control:** the project isn't a git repository, so nothing is committed or backed up. CI only runs once the code is pushed. **Do this first.**
- **Image builds** weren't run here (Docker Desktop broken). CI will build them.
- **Load test** not run: it needs staging and k6.
- **External penetration test** not done: recommended before or soon after launch.
- **MFA at login** not built (the architecture is ready).
- **Veltrix credentials** are plain text in Veltrix's own database (its access tokens and app secrets).
- **Waiting on you:** live keys and credentials, key rotation, legal review, and the business numbers listed in the go-live checklist.
