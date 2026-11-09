import { parse } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ProviderRequestError } from '../src/payments/payment-provider';
import { PaystackAdapter } from '../src/payments/paystack.adapter';

/**
 * Real Paystack TEST-mode calls through the adapter (rule 6: no integration is claimed without a sandbox test).
 * Uses PAYSTACK_SECRET_KEY from apps/api/.env (gitignored) or TEST_PAYSTACK_SECRET_KEY; skipped when neither is a
 * test key. Live keys are refused so this can never move real money.
 */
const file = join(__dirname, '..', '.env');
const fromFile = existsSync(file) ? parse(readFileSync(file)).PAYSTACK_SECRET_KEY : undefined;
const key = process.env.TEST_PAYSTACK_SECRET_KEY || fromFile || '';
const run = key.startsWith('sk_test_') ? describe : describe.skip;

run('Paystack sandbox (real API, test mode)', () => {
  const adapter = new PaystackAdapter();
  const creds = { secretKey: key };
  const ref = () => `LS-SBX-${randomBytes(6).toString('hex')}`;
  jest.setTimeout(30_000);

  it('accepts the test key and rejects a bogus one', async () => {
    expect(await adapter.validateCredentials(creds)).toEqual({ valid: true, testMode: true });
    expect((await adapter.validateCredentials({ secretKey: 'sk_test_0000000000000000000000000000000000000000' })).valid).toBe(false);
  });

  it('initializes a kobo payment, verifies it as not yet paid, and refuses a duplicate reference', async () => {
    const reference = ref();
    const init = await adapter.initializePayment(creds, {
      reference, amountMinor: 250_000n, currency: 'NGN', customerEmail: 'sandbox-buyer@example.com', callbackUrl: 'http://localhost:3000/payments/return',
      metadata: { purpose: 'sandbox-test' },
    });
    expect(init.checkoutUrl).toMatch(/^https:\/\/checkout\.paystack\.com\//);
    const v = await adapter.verifyPayment(creds, reference);
    expect(v).toMatchObject({ status: 'ABANDONED', amountMinor: 250_000n, currency: 'NGN', testMode: true });
    expect(v.paidAt).toBeNull();
    await expect(adapter.initializePayment(creds, {
      reference, amountMinor: 250_000n, currency: 'NGN', customerEmail: 'sandbox-buyer@example.com', callbackUrl: 'http://localhost:3000/payments/return', metadata: {},
    })).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('reports an unknown reference as NOT_FOUND', async () => {
    expect((await adapter.verifyPayment(creds, ref())).status).toBe('NOT_FOUND');
  });

  it('declines a refund for a payment that was never completed', async () => {
    const reference = ref();
    await adapter.initializePayment(creds, { reference, amountMinor: 10_000n, currency: 'NGN', customerEmail: 'sandbox-buyer@example.com', callbackUrl: 'http://localhost:3000/payments/return', metadata: {} });
    await expect(adapter.refundPayment(creds, { reference, providerReference: null, amountMinor: 10_000n, currency: 'NGN', refundId: ref() })).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('lists Nigerian banks', async () => {
    const banks = await adapter.listBanks();
    expect(banks.length).toBeGreaterThan(10);
    expect(banks).toEqual(expect.arrayContaining([expect.objectContaining({ code: '058' })]));
  });
});
