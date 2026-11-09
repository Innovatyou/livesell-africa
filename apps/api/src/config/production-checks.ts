import type { Env } from './env';

/**
 * Production and staging must not start with development settings (MASTER-SPEC §27: separate environments; never
 * production credentials in dev). Pure, unit-tested. Returns every problem at once so a deploy fails with a full list.
 */
export function productionProblems(e: Env): string[] {
  if (e.NODE_ENV !== 'production' && e.NODE_ENV !== 'staging') return [];
  const out: string[] = [];
  const local = (u: string) => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(u);
  const weak = (v: string) => /change[-_]?me|placeholder|example|secret{2,}|^(.)\1+$/i.test(v);

  if (!e.COOKIE_SECURE) out.push('COOKIE_SECURE must be true');
  for (const [k, v] of [['APP_URL', e.APP_URL], ['API_PUBLIC_URL', e.API_PUBLIC_URL]] as const) {
    if (!v.startsWith('https://')) out.push(`${k} must be https`);
    if (local(v)) out.push(`${k} must not point to localhost`);
  }
  const origins = e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!origins.length || origins.some((o) => o === '*' || local(o) || !o.startsWith('https://'))) out.push('CORS_ORIGINS must list only https origins (no *, no localhost)');
  if (weak(e.JWT_ACCESS_SECRET)) out.push('JWT_ACCESS_SECRET looks like a placeholder');
  if (weak(e.TOKEN_HASH_SECRET)) out.push('TOKEN_HASH_SECRET looks like a placeholder');
  if (e.JWT_ACCESS_SECRET === e.TOKEN_HASH_SECRET) out.push('JWT_ACCESS_SECRET and TOKEN_HASH_SECRET must differ');
  if (e.S3_ENDPOINT && local(e.S3_ENDPOINT)) out.push('S3_ENDPOINT must not point to localhost');
  const dbHost = (() => { try { return new URL(e.DATABASE_URL).hostname; } catch { return ''; } })();
  if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(dbHost)) out.push('DATABASE_URL points to localhost (use the managed database)');
  if (e.NODE_ENV === 'production') {
    // Live money needs live keys; test keys belong to staging.
    if (e.PAYSTACK_SECRET_KEY?.startsWith('sk_test_')) out.push('PAYSTACK_SECRET_KEY is a test key in production');
    if (e.FLUTTERWAVE_SECRET_KEY?.includes('_TEST-')) out.push('FLUTTERWAVE_SECRET_KEY is a test key in production');
    if (e.BACHS_API_KEY?.startsWith('sk_sandbox_')) out.push('BACHS_API_KEY is a sandbox key in production');
  }
  return out;
}
