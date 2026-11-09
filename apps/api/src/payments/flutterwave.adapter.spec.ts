import { ProviderRequestError, ProviderUnavailableError } from './payment-provider';
import { FlutterwaveAdapter, mapFlwRefund, mapFlwStatus } from './flutterwave.adapter';

const creds = { secretKey: 'FLWSECK' + '_TEST-0123456789abcdef0123456789abcdef-X', webhookSecret: 'flw-hash-0123456789abcdef' };
const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('FlutterwaveAdapter', () => {
  const a = new FlutterwaveAdapter();
  let fetchMock: jest.SpyInstance;
  beforeEach(() => { fetchMock = jest.spyOn(globalThis, 'fetch'); });
  afterEach(() => fetchMock.mockRestore());
  const last = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string>).Authorization };
  };

  it('recognises test and live secret keys', () => {
    expect(a.keyMode(creds.secretKey)).toBe('test');
    expect(a.keyMode('FLWSECK' + '-0123456789abcdef0123456789abcdef-X')).toBe('live');
    expect(a.keyMode('sk_test_abc')).toBeNull();
  });

  it('starts a Standard payment in naira (exact decimal) with the reference, redirect and split charge', async () => {
    fetchMock.mockImplementation(() => json(200, { status: 'success', message: 'Hosted Link', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/x' } }));
    const r = await a.initializePayment(creds, { reference: 'LS-ABC-1', amountMinor: 2_500_050n, currency: 'NGN', customerEmail: 'a@b.ng', customerName: 'Ada', callbackUrl: 'https://app/r', metadata: { o: '1' } });
    expect(r.checkoutUrl).toMatch(/checkout\.flutterwave\.com/);
    expect(last()).toMatchObject({ url: 'https://api.flutterwave.com/v3/payments', method: 'POST', auth: `Bearer ${creds.secretKey}` });
    expect(last().body).toMatchObject({ tx_ref: 'LS-ABC-1', amount: '25000.50', currency: 'NGN', redirect_url: 'https://app/r', customer: { email: 'a@b.ng', name: 'Ada' }, meta: { o: '1' } });
    expect(last().body.subaccounts).toBeUndefined();
    await a.initializePayment(creds, { reference: 'LS-ABC-2', amountMinor: 1_000_000n, currency: 'NGN', customerEmail: 'a@b.ng', callbackUrl: 'u', metadata: {}, split: { subaccountCode: 'RS_1', platformChargeMinor: 30_000n } });
    expect(last().body.subaccounts).toEqual([{ id: 'RS_1', transaction_charge_type: 'flat', transaction_charge: '300.00' }]);
    await a.initializePayment(creds, { reference: 'LS-ABC-3', amountMinor: 1_000_000n, currency: 'NGN', customerEmail: 'a@b.ng', callbackUrl: 'u', metadata: {}, split: { subaccountCode: 'RS_1', platformChargeMinor: 0n } });
    expect(last().body.subaccounts).toEqual([{ id: 'RS_1' }]); // trial: no commission override
  });

  it('verifies by our reference: kobo amount, fee, provider id; "no transaction" = NOT_FOUND', async () => {
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', message: 'ok', data: { id: 3091255, tx_ref: 'LS-ABC-1', status: 'successful', amount: 25000.5, currency: 'NGN', app_fee: 351.75, created_at: '2026-11-06T10:00:00.000Z', processor_response: 'Approved' } }));
    const v = await a.verifyPayment(creds, 'LS-ABC-1');
    expect(last().url).toBe('https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=LS-ABC-1');
    expect(v).toMatchObject({ status: 'SUCCEEDED', amountMinor: 2_500_050n, currency: 'NGN', providerReference: '3091255', feeMinor: 35_175n, testMode: true });
    fetchMock.mockImplementationOnce(() => json(400, { status: 'error', message: 'No transaction was found for this id', data: null }));
    expect((await a.verifyPayment(creds, 'LS-NOPE')).status).toBe('NOT_FOUND');
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', message: 'ok', data: { id: 1, tx_ref: 'SOMETHING-ELSE', status: 'successful', amount: 1, currency: 'NGN' } }));
    await expect(a.verifyPayment(creds, 'LS-ABC-1')).rejects.toBeInstanceOf(ProviderRequestError);
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', message: 'ok', data: { id: 2, tx_ref: 'LS-ABC-1', status: 'successful', amount: 100.005, currency: 'NGN' } }));
    expect((await a.verifyPayment(creds, 'LS-ABC-1')).amountMinor).toBeNull(); // sub-kobo amount can never match an order
  });

  it('treats outages as unavailable and a bad key as invalid', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(a.verifyPayment(creds, 'R')).rejects.toBeInstanceOf(ProviderUnavailableError);
    fetchMock.mockImplementationOnce(() => json(503, {}));
    await expect(a.verifyPayment(creds, 'R')).rejects.toBeInstanceOf(ProviderUnavailableError);
    fetchMock.mockImplementationOnce(() => json(401, { status: 'error', message: 'Invalid authorization key', data: null }));
    expect(await a.validateCredentials(creds)).toEqual({ valid: false, testMode: true });
  });

  it('accepts a webhook only when verif-hash equals the secret hash', () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.completed', data: { id: 285959875, tx_ref: 'LS-ABC-1', status: 'successful' } }));
    expect(a.parseWebhook(creds, body, { 'verif-hash': creds.webhookSecret })).toEqual({ eventId: 'charge.completed:285959875:successful', eventType: 'charge.completed', paymentReference: 'LS-ABC-1' });
    expect(a.parseWebhook(creds, body, { 'verif-hash': 'wrong' })).toBeNull();
    expect(a.parseWebhook(creds, body, {})).toBeNull();
    expect(a.parseWebhook({ secretKey: creds.secretKey }, body, { 'verif-hash': creds.webhookSecret })).toBeNull(); // no secret configured
  });

  it('refunds by Flutterwave transaction id in naira and tracks the refund by flw_ref', async () => {
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', message: 'Transaction refund initiated', data: { id: 75923, flw_ref: 'URF_1', status: 'completed', amount_refunded: 69 } }));
    const r = await a.refundPayment(creds, { reference: 'LS-ABC-1', providerReference: '908790', amountMinor: 6_900n, currency: 'NGN', note: 'Out of stock', refundId: 'rf1' });
    expect(last()).toMatchObject({ url: 'https://api.flutterwave.com/v3/transactions/908790/refund', body: { amount: '69.00', comments: 'Out of stock' } });
    expect(r).toMatchObject({ providerReference: 'URF_1', status: 'SUCCEEDED' });
    await expect(a.refundPayment(creds, { reference: 'x', providerReference: null, amountMinor: 1n, currency: 'NGN', refundId: 'r' })).rejects.toBeInstanceOf(ProviderRequestError);
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', message: 'Refunds fetched', data: [{ flw_ref: 'URF_1', status: 'completed-mpgs' }] }));
    expect((await a.getRefund(creds, 'URF_1')).status).toBe('SUCCEEDED');
    expect(last().url).toBe('https://api.flutterwave.com/v3/refunds?flw_ref=URF_1');
    expect([mapFlwRefund('completed'), mapFlwRefund('failed'), mapFlwRefund('pending'), mapFlwStatus('successful'), mapFlwStatus('failed'), mapFlwStatus('pending'), mapFlwStatus('cancelled')])
      .toEqual(['SUCCEEDED', 'FAILED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'PENDING', 'ABANDONED']);
  });

  it('creates a subaccount with a zero default split (commission is set per payment)', async () => {
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', message: 'Subaccount created', data: { subaccount_id: 'RS_ABC' } }));
    const r = await a.createSubaccount(creds, { businessName: 'Ada Fashion', bankCode: '044', accountNumber: '0690000032', contactPhone: '+2348031234567' });
    expect(r.subaccountCode).toBe('RS_ABC');
    expect(last().body).toMatchObject({ account_bank: '044', account_number: '0690000032', business_name: 'Ada Fashion', country: 'NG', business_mobile: '08031234567', split_type: 'flat', split_value: 0 });
  });
});
