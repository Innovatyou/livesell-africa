import { shouldAlert } from '../common/observability';
import type { Env } from './env';
import { productionProblems } from './production-checks';

const good = {
  NODE_ENV: 'production', COOKIE_SECURE: true, APP_URL: 'https://app.livesell.africa', API_PUBLIC_URL: 'https://api.livesell.africa',
  CORS_ORIGINS: 'https://app.livesell.africa', JWT_ACCESS_SECRET: 'k3Jw9vQ2xZ7pL4mN8bR1tY6uE0aS5dF3', TOKEN_HASH_SECRET: 'Zx81Vb2Nm3Qw4Er5Ty6Ui7Op8As9Df0Gh',
  DATABASE_URL: 'postgresql://u:p@db.internal:5432/livesell', S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  PAYSTACK_SECRET_KEY: 'sk_live_abc', FLUTTERWAVE_SECRET_KEY: undefined, BACHS_API_KEY: undefined,
} as unknown as Env;

describe('production configuration checks', () => {
  it('a proper production config passes; development is never checked', () => {
    expect(productionProblems(good)).toEqual([]);
    expect(productionProblems({ ...good, NODE_ENV: 'development', COOKIE_SECURE: false, APP_URL: 'http://localhost:3000' })).toEqual([]);
  });

  it('refuses development settings in production and staging, listing every problem', () => {
    const p = productionProblems({ ...good, NODE_ENV: 'staging', COOKIE_SECURE: false, APP_URL: 'http://localhost:3000', CORS_ORIGINS: '*', DATABASE_URL: 'postgresql://u:p@localhost:5432/x', S3_ENDPOINT: 'http://127.0.0.1:9000' });
    expect(p).toEqual(expect.arrayContaining([
      'COOKIE_SECURE must be true', 'APP_URL must be https', 'APP_URL must not point to localhost',
      'CORS_ORIGINS must list only https origins (no *, no localhost)', 'S3_ENDPOINT must not point to localhost', 'DATABASE_URL points to localhost (use the managed database)',
    ]));
  });

  it('refuses placeholder or shared secrets, and test payment keys in production (but not staging)', () => {
    expect(productionProblems({ ...good, JWT_ACCESS_SECRET: 'change-me-change-me-change-me-123' })).toContain('JWT_ACCESS_SECRET looks like a placeholder');
    expect(productionProblems({ ...good, TOKEN_HASH_SECRET: good.JWT_ACCESS_SECRET })).toContain('JWT_ACCESS_SECRET and TOKEN_HASH_SECRET must differ');
    expect(productionProblems({ ...good, PAYSTACK_SECRET_KEY: 'sk_test_x' })).toContain('PAYSTACK_SECRET_KEY is a test key in production');
    expect(productionProblems({ ...good, BACHS_API_KEY: 'sk_sandbox_abcdefghijklmnop' })).toContain('BACHS_API_KEY is a sandbox key in production');
    expect(productionProblems({ ...good, NODE_ENV: 'staging', PAYSTACK_SECRET_KEY: 'sk_test_x' })).toEqual([]);
  });

  it('error alerts: at most one per distinct error per 5 minutes', () => {
    const seen = new Map<string, number>();
    expect(shouldAlert('GET /x:Error:boom', 1_000_000, seen)).toBe(true);
    expect(shouldAlert('GET /x:Error:boom', 1_100_000, seen)).toBe(false);
    expect(shouldAlert('GET /y:Error:boom', 1_100_000, seen)).toBe(true);
    expect(shouldAlert('GET /x:Error:boom', 1_000_000 + 5 * 60_000, seen)).toBe(true);
  });
});
