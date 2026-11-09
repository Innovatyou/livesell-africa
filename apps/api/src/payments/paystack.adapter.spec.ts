import { createHmac } from 'node:crypto';
import { ProviderRequestError, ProviderUnavailableError } from './payment-provider';
import { mapRefund, mapStatus, PaystackAdapter } from './paystack.adapter';

const creds = { secretKey: 'sk_test_unit' };
const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('PaystackAdapter', () => {
  const adapter = new PaystackAdapter();
  let fetchMock: jest.SpyInstance;
  beforeEach(() => { fetchMock = jest.spyOn(globalThis, 'fetch'); });
  afterEach(() => fetchMock.mockRestore());
  const lastCall = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, init, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string>).Authorization };
  };

  it('initializes in kobo with the reference, callback and stringified metadata; adds split fields', async () => {
    fetchMock.mockImplementation(() => json(200, { status: true, message: 'ok', data: { authorization_url: 'https://checkout.paystack.com/x', access_code: 'x', reference: 'R1' } }));
    const r = await adapter.initializePayment(creds, { reference: 'R1', amountMinor: 2500000n, currency: 'NGN', customerEmail: 'a@b.ng', callbackUrl: 'https://app/r', metadata: { a: '1' } });
    expect(r.checkoutUrl).toBe('https://checkout.paystack.com/x');
    let c = lastCall();
    expect(c.url).toBe('https://api.paystack.co/transaction/initialize');
    expect(c.auth).toBe('Bearer sk_test_unit');
    expect(c.body).toEqual({ email: 'a@b.ng', amount: '2500000', currency: 'NGN', reference: 'R1', callback_url: 'https://app/r', metadata: '{"a":"1"}' });

    await adapter.initializePayment(creds, { reference: 'R2', amountMinor: 10000n, currency: 'NGN', customerEmail: 'a@b.ng', callbackUrl: 'u', metadata: {}, split: { subaccountCode: 'ACCT_1', platformChargeMinor: 300n } });
    c = lastCall();
    expect(c.body).toMatchObject({ subaccount: 'ACCT_1', transaction_charge: '300', bearer: 'subaccount' });
  });

  it('maps a verify response (status, kobo, fee, provider id, test mode)', async () => {
    fetchMock.mockImplementation(() => json(200, { status: true, message: 'ok', data: { id: 42, status: 'success', amount: 2500000, currency: 'NGN', fees: 37500, paid_at: '2026-11-06T10:00:00.000Z', gateway_response: 'Approved', domain: 'test' } }));
    const v = await adapter.verifyPayment(creds, 'LS-ABC/1');
    expect(lastCall().url).toBe('https://api.paystack.co/transaction/verify/LS-ABC%2F1');
    expect(v).toMatchObject({ status: 'SUCCEEDED', amountMinor: 2500000n, currency: 'NGN', providerReference: '42', feeMinor: 37500n, testMode: true, message: 'Approved' });
    expect(v.paidAt?.toISOString()).toBe('2026-11-06T10:00:00.000Z');
  });

  it('reports an unknown reference as NOT_FOUND and other rejections as request errors', async () => {
    fetchMock.mockReturnValueOnce(json(400, { status: false, message: 'Transaction reference not found.', code: 'transaction_not_found' }));
    expect((await adapter.verifyPayment(creds, 'nope')).status).toBe('NOT_FOUND');
    fetchMock.mockReturnValueOnce(json(400, { status: false, message: 'Duplicate Transaction Reference', code: 'duplicate_reference' }));
    await expect(adapter.initializePayment(creds, { reference: 'R', amountMinor: 1n, currency: 'NGN', customerEmail: 'a@b.ng', callbackUrl: 'u', metadata: {} })).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('treats network errors, timeouts, 5xx and 429 as "provider unavailable" (§26 #11)', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    await expect(adapter.verifyPayment(creds, 'R')).rejects.toBeInstanceOf(ProviderUnavailableError);
    fetchMock.mockReturnValueOnce(json(502, { status: false, message: 'Bad gateway' }));
    await expect(adapter.verifyPayment(creds, 'R')).rejects.toBeInstanceOf(ProviderUnavailableError);
    fetchMock.mockReturnValueOnce(json(429, { status: false, message: 'Slow down' }));
    await expect(adapter.verifyPayment(creds, 'R')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('validates a key against an authenticated endpoint (401 = invalid)', async () => {
    fetchMock.mockReturnValueOnce(json(401, { status: false, message: 'Invalid key' }));
    expect(await adapter.validateCredentials({ secretKey: 'sk_live_bad' })).toEqual({ valid: false, testMode: false });
    fetchMock.mockReturnValueOnce(json(200, { status: true, message: 'ok', data: [] }));
    expect(await adapter.validateCredentials(creds)).toEqual({ valid: true, testMode: true });
    expect(lastCall().url).toBe('https://api.paystack.co/transaction?perPage=1');
  });

  it('refund request fields and status mapping', async () => {
    fetchMock.mockImplementation(() => json(200, { status: true, message: 'ok', data: { id: 7, status: 'pending' } }));
    const r = await adapter.refundPayment(creds, { reference: 'R1', providerReference: '42', amountMinor: 5000n, currency: 'NGN', note: 'Out of stock', refundId: 'rf-1' });
    expect(lastCall().body).toEqual({ transaction: 'R1', amount: '5000', currency: 'NGN', merchant_note: 'Out of stock' });
    expect(r).toMatchObject({ providerReference: '7', status: 'PROCESSING' });
    expect([mapRefund('processed'), mapRefund('failed'), mapRefund('pending'), mapRefund(undefined)]).toEqual(['SUCCEEDED', 'FAILED', 'PROCESSING', 'PROCESSING']);
    expect([mapStatus('success'), mapStatus('failed'), mapStatus('abandoned'), mapStatus('reversed'), mapStatus('ongoing')]).toEqual(['SUCCEEDED', 'FAILED', 'ABANDONED', 'REVERSED', 'PENDING']);
  });

  it('accepts a webhook only with a valid HMAC-SHA512 signature over the raw body', () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 9, reference: 'R1', status: 'success' } }));
    const sig = createHmac('sha512', creds.secretKey).update(body).digest('hex');
    expect(adapter.parseWebhook(creds, body, { 'x-paystack-signature': sig })).toEqual({ eventId: 'charge.success:9:success', eventType: 'charge.success', paymentReference: 'R1', refundProviderReference: undefined });
    expect(adapter.parseWebhook(creds, body, {})).toBeNull();
    expect(adapter.parseWebhook({ secretKey: 'sk_test_other' }, body, { 'x-paystack-signature': sig })).toBeNull();
    const tampered = Buffer.from(body.toString().replace('R1', 'R2'));
    expect(adapter.parseWebhook(creds, tampered, { 'x-paystack-signature': sig })).toBeNull();
  });
});
