import { parse } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BachsAdapter } from '../src/payments/bachs.adapter';
import { ProviderRequestError } from '../src/payments/payment-provider';

/**
 * Real Bachs SANDBOX calls through the adapter (rule 6). Uses BACHS_API_KEY from apps/api/.env (gitignored) or
 * TEST_BACHS_API_KEY; skipped without an sk_sandbox_ key; live keys are refused.
 */
const file = join(__dirname, '..', '.env');
const fromFile = existsSync(file) ? parse(readFileSync(file)).BACHS_API_KEY : undefined;
const key = process.env.TEST_BACHS_API_KEY || fromFile || '';
const run = key.startsWith('sk_sandbox_') ? describe : describe.skip;

run('Bachs sandbox (real API)', () => {
  const a = new BachsAdapter();
  const creds = { secretKey: key };
  const ref = () => `LS-SBX-${randomBytes(6).toString('hex')}`;
  const base = { currency: 'NGN', customerEmail: 'sandbox-buyer@example.com', customerName: 'Sandbox Buyer', callbackUrl: 'http://localhost:3000/payments/return', metadata: { purpose: 'sandbox-test' } };
  jest.setTimeout(45_000);

  it('accepts the sandbox key and rejects a bogus one', async () => {
    expect(await a.validateCredentials(creds)).toEqual({ valid: true, testMode: true });
    expect((await a.validateCredentials({ secretKey: 'sk_sandbox_00000000_badbadbadbadbadbadbadbad' })).valid).toBe(false);
  });

  it('creates an NGN checkout (localhost redirect left out), verifies it as open with its charge id; a retried request returns the same checkout', async () => {
    const reference = ref();
    const r = await a.initializePayment(creds, { ...base, reference, amountMinor: 250_000n });
    expect(r.checkoutUrl).toMatch(/^https:\/\/[\w.-]*bachs\.io\//);
    expect(r.providerCheckoutId).toMatch(/^chk_/);
    const v = await a.verifyPayment(creds, reference, { providerCheckoutId: r.providerCheckoutId });
    expect(v).toMatchObject({ status: 'PENDING', currency: 'NGN', testMode: true, providerReference: expect.stringMatching(/^ch_/) });
    // Our reference is also the Idempotency-Key, so a retry after a dropped connection can't create a second checkout.
    const again = await a.initializePayment(creds, { ...base, reference, amountMinor: 250_000n });
    expect(again.providerCheckoutId).toBe(r.providerCheckoutId);
  });

  it('reports an unknown checkout as NOT_FOUND', async () => {
    expect((await a.verifyPayment(creds, ref(), { providerCheckoutId: 'chk_doesnotexist000' })).status).toBe('NOT_FOUND');
  });

  it('refuses a refund for an unpaid charge (or reports a key without the refunds:write scope)', async () => {
    const reference = ref();
    const r = await a.initializePayment(creds, { ...base, reference, amountMinor: 10_000n });
    const v = await a.verifyPayment(creds, reference, { providerCheckoutId: r.providerCheckoutId });
    const err = await a.refundPayment(creds, { reference, providerReference: v.providerReference, amountMinor: 10_000n, currency: 'NGN', refundId: ref() }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    if ((err as ProviderRequestError).providerCode === 'FORBIDDEN') {
      // The key can't create refunds at all: the refund path is NOT verified against Bachs until the key has the scope.
      expect((err as Error).message).toMatch(/refunds:write/);
      console.warn('Bachs sandbox key lacks refunds:write — refund behaviour unverified against the real API');
      return;
    }
    expect((err as ProviderRequestError).providerCode).toBe('BAD_REQUEST'); // "Charge is not refundable in status …"
  });
});
