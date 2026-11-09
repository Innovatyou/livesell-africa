import { createHmac } from 'node:crypto';
import { BachsAdapter, mapBachsCharge, mapBachsRefund } from './bachs.adapter';
import { isPublicUrl, ProviderCapabilityError, ProviderRequestError, ProviderUnavailableError } from './payment-provider';

const creds = { secretKey: 'sk_sandbox_0123abcd_ABCDEFGHIJKLMNOPQRSTUV', webhookSecret: 'whsec_0123456789abcdef0123' };
const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const session = (charge: Record<string, unknown> | null, over: Record<string, unknown> = {}) => ({ checkout_id: 'chk_1', status: 'open', reference: 'LS-ABC-1', amount: '25000.00', currency: 'NGN', charge, ...over });

describe('BachsAdapter', () => {
  const a = new BachsAdapter();
  let fetchMock: jest.SpyInstance;
  beforeEach(() => { fetchMock = jest.spyOn(globalThis, 'fetch'); });
  afterEach(() => fetchMock.mockRestore());
  const last = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
  };

  it('picks the environment from the key', async () => {
    expect([a.keyMode(creds.secretKey), a.keyMode('sk_live_0123abcd_ABCDEFGHIJKLMNOP'), a.keyMode('sk_test_x')]).toEqual(['test', 'live', null]);
    fetchMock.mockImplementation(() => json(200, { items: [] }));
    expect(await a.validateCredentials(creds)).toEqual({ valid: true, testMode: true });
    expect(last().url).toBe('https://sandbox-api.bachs.io/v1/payments?limit=1');
    await a.validateCredentials({ secretKey: 'sk_live_0123abcd_ABCDEFGHIJKLMNOP' });
    expect(last().url).toBe('https://api.bachs.io/v1/payments?limit=1');
  });

  it('creates a raw-amount checkout in decimal naira with our reference as idempotency key; redirect only to public URLs', async () => {
    fetchMock.mockImplementation(() => json(201, { checkout_id: 'chk_1', checkout_url: 'https://sandbox-checkout.bachs.io/c/x', status: 'open' }));
    const r = await a.initializePayment(creds, { reference: 'LS-ABC-1', amountMinor: 2_500_000n, currency: 'NGN', customerEmail: 'a@b.ng', customerName: 'Ada', callbackUrl: 'http://localhost:3000/payments/return', metadata: { o: '1' } });
    expect(r).toEqual({ checkoutUrl: 'https://sandbox-checkout.bachs.io/c/x', providerCheckoutId: 'chk_1' });
    expect(last().headers['Idempotency-Key']).toBe('LS-ABC-1');
    expect(last().body).toEqual({ pricing: { currency: 'NGN', amount: '25000.00' }, customer: { email: 'a@b.ng', name: 'Ada' }, reference: 'LS-ABC-1', metadata: { o: '1' }, expires_in_minutes: 1440 });
    await a.initializePayment(creds, { reference: 'LS-ABC-2', amountMinor: 100n, currency: 'NGN', customerEmail: 'a@b.ng', callbackUrl: 'https://app.livesell.africa/payments/return', metadata: {} });
    expect(last().body.success_url).toBe('https://app.livesell.africa/payments/return?reference=LS-ABC-2&provider=bachs');
    await expect(a.initializePayment(creds, { reference: 'x', amountMinor: 1n, currency: 'NGN', customerEmail: 'a@b.ng', callbackUrl: 'u', metadata: {}, split: { subaccountCode: 's', platformChargeMinor: 1n } })).rejects.toBeInstanceOf(ProviderCapabilityError);
  });

  it('verifies through the checkout session: charge status, amount paid, fee in the charge currency', async () => {
    fetchMock.mockImplementationOnce(() => json(200, session({ payment_id: 'ch_9', status: 'succeeded', amount: '25000.00', amount_paid: '25000.00', currency: 'NGN', fees: { amount: '375.00', currency: 'NGN' }, completed_at: '2026-11-06T10:00:00Z', message: 'Successful' }, { status: 'completed' })));
    const v = await a.verifyPayment(creds, 'LS-ABC-1', { providerCheckoutId: 'chk_1' });
    expect(last().url).toBe('https://sandbox-api.bachs.io/v1/checkout-sessions/chk_1');
    expect(v).toMatchObject({ status: 'SUCCEEDED', amountMinor: 2_500_000n, currency: 'NGN', providerReference: 'ch_9', feeMinor: 37_500n, testMode: true });

    fetchMock.mockImplementationOnce(() => json(200, session({ payment_id: 'ch_9', status: 'underpaid', amount: '25000.00', amount_paid: '20000.00', currency: 'NGN', fees: null, completed_at: null, message: null })));
    expect(await a.verifyPayment(creds, 'LS-ABC-1', { providerCheckoutId: 'chk_1' })).toMatchObject({ status: 'SUCCEEDED', amountMinor: 2_000_000n }); // mismatch is caught by the service

    fetchMock.mockImplementationOnce(() => json(200, session({ payment_id: 'ch_9', status: 'open', amount: '25000.00', amount_paid: '0.00', currency: 'NGN', fees: null, completed_at: null, message: 'Open' })));
    expect((await a.verifyPayment(creds, 'LS-ABC-1', { providerCheckoutId: 'chk_1' })).status).toBe('PENDING');
    fetchMock.mockImplementationOnce(() => json(200, session(null, { status: 'expired' })));
    expect((await a.verifyPayment(creds, 'LS-ABC-1', { providerCheckoutId: 'chk_1' })).status).toBe('ABANDONED');
    fetchMock.mockImplementationOnce(() => json(404, { detail: 'Checkout not found', error_code: 'NOT_FOUND' }));
    expect((await a.verifyPayment(creds, 'LS-ABC-1', { providerCheckoutId: 'chk_x' })).status).toBe('NOT_FOUND');
    expect((await a.verifyPayment(creds, 'LS-ABC-1')).status).toBe('NOT_FOUND'); // no checkout id recorded → no call
    fetchMock.mockImplementationOnce(() => json(200, session(null, { reference: 'OTHER' })));
    await expect(a.verifyPayment(creds, 'LS-ABC-1', { providerCheckoutId: 'chk_1' })).rejects.toBeInstanceOf(ProviderRequestError);
    fetchMock.mockImplementationOnce(() => json(502, { detail: 'bad gateway' }));
    await expect(a.verifyPayment(creds, 'LS-ABC-1', { providerCheckoutId: 'chk_1' })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('maps every documented charge and refund status', () => {
    const c = ['succeeded', 'partially_refunded', 'accepted', 'underpaid', 'overpaid', 'failed', 'refunded', 'auto_refunded', 'incomplete', 'expired', 'cancelled', 'open', 'created', 'processing'].map(mapBachsCharge);
    expect(c).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'FAILED', 'REVERSED', 'REVERSED', 'ABANDONED', 'ABANDONED', 'ABANDONED', 'PENDING', 'PENDING', 'PENDING']);
    expect(['processing', 'success', 'paid', 'failed'].map(mapBachsRefund)).toEqual(['PROCESSING', 'SUCCEEDED', 'SUCCEEDED', 'FAILED']);
  });

  it('verifies X-Bachs-Signature-V2 (HMAC-SHA256 of "t.body", any v1, 300 s window)', () => {
    const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'collection.succeeded', data: { checkout_id: 'chk_1', reference: 'LS-ABC-1', charge_id: 'ch_9' } }));
    const t = 1_800_000_000;
    const sig = (secret: string) => createHmac('sha256', secret).update(`${t}.${body.toString()}`).digest('hex');
    const now = t * 1000;
    expect(a.parseWebhook(creds, body, { 'x-bachs-signature-v2': `t=${t},v1=${sig(creds.webhookSecret)}` }, now))
      .toEqual({ eventId: 'evt_1', eventType: 'collection.succeeded', paymentReference: 'LS-ABC-1', providerCheckoutId: 'chk_1' });
    expect(a.parseWebhook(creds, body, { 'x-bachs-signature-v2': `t=${t},v1=${sig('old-secret')},v1=${sig(creds.webhookSecret)}` }, now)).not.toBeNull(); // rotation
    expect(a.parseWebhook(creds, body, { 'x-bachs-signature-v2': `t=${t},v1=${sig('wrong')}` }, now)).toBeNull();
    expect(a.parseWebhook(creds, body, { 'x-bachs-signature-v2': `t=${t},v1=${sig(creds.webhookSecret)}` }, now + 301_000)).toBeNull(); // replay
    expect(a.parseWebhook(creds, Buffer.from(body.toString().replace('LS-ABC-1', 'LS-ABC-2')), { 'x-bachs-signature-v2': `t=${t},v1=${sig(creds.webhookSecret)}` }, now)).toBeNull();
    expect(a.parseWebhook({ secretKey: creds.secretKey }, body, { 'x-bachs-signature-v2': `t=${t},v1=${sig(creds.webhookSecret)}` }, now)).toBeNull();
    const refund = Buffer.from(JSON.stringify({ id: 'evt_2', type: 'refund.paid', data: { refund_id: 'rfnd_1', charge_id: 'ch_9', status: 'paid' } }));
    const rs = createHmac('sha256', creds.webhookSecret).update(`${t}.${refund.toString()}`).digest('hex');
    expect(a.parseWebhook(creds, refund, { 'x-bachs-signature-v2': `t=${t},v1=${rs}` }, now)).toEqual({ eventId: 'evt_2', eventType: 'refund.paid', refundProviderReference: 'rfnd_1' });
  });

  it('refunds by charge id with our refund id as reference and idempotency key', async () => {
    fetchMock.mockImplementationOnce(() => json(201, { refund_id: 'rfnd_1', charge_id: 'ch_9', status: 'processing' }));
    const r = await a.refundPayment(creds, { reference: 'LS-ABC-1', providerReference: 'ch_9', amountMinor: 1_000_050n, currency: 'NGN', note: 'Damaged', refundId: 'rf-uuid' });
    expect(last()).toMatchObject({ url: 'https://sandbox-api.bachs.io/v1/refunds', body: { charge_id: 'ch_9', reference: 'rf-uuid', amount: '10000.50', idempotency_key: 'rf-uuid', reason: 'Damaged' } });
    expect(last().headers['Idempotency-Key']).toBe('rf-uuid');
    expect(r).toMatchObject({ providerReference: 'rfnd_1', status: 'PROCESSING' });
    fetchMock.mockImplementationOnce(() => json(409, { detail: 'A refund already exists for this charge', error_code: 'CONFLICT' }));
    await expect(a.refundPayment(creds, { reference: 'x', providerReference: 'ch_9', amountMinor: 1n, currency: 'NGN', refundId: 'r2' })).rejects.toMatchObject({ providerCode: 'CONFLICT' });
    expect(a.capabilities.multipleRefunds).toBe(false);
  });

  it('knows which redirect URLs are public', () => {
    expect([isPublicUrl('https://app.livesell.africa/x'), isPublicUrl('http://localhost:3000'), isPublicUrl('http://192.168.1.5'), isPublicUrl('http://10.0.0.1'), isPublicUrl('ftp://x.com')]).toEqual([true, false, false, false, false]);
  });
});
