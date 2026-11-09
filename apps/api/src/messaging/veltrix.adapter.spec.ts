import { ConfigService } from '@nestjs/config';
import { MessagingNotConfiguredError, MessagingRejectedError, MessagingUnavailableError } from './messaging-provider';
import { VeltrixMessagingAdapter, VeltrixVerifyAdapter } from './veltrix.adapter';

const ENV: Record<string, unknown> = {
  VELTRIX_ENABLED: true, VELTRIX_BASE_URL: 'https://veltrix.test/', VELTRIX_API_KEY: 'mw-key-0123456789abcdef', VELTRIX_SMS_SENDER: 'LIVESELL',
  VELTRIX_EMAIL_FROM: 'hello@livesell.africa', VELTRIX_EMAIL_FROM_NAME: 'LiveSell Africa', VELTRIX_WHATSAPP_SERVER_UID: 'wa123', VELTRIX_VERIFY_KEY: 'kid_1.secret',
};
const config = (over: Record<string, unknown> = {}) => ({ get: (k: string) => ({ ...ENV, ...over })[k] }) as unknown as ConfigService<never, true>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } }));

describe('VeltrixMessagingAdapter', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => { fetchMock = jest.spyOn(globalThis, 'fetch'); });
  afterEach(() => fetchMock.mockRestore());
  const last = () => {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, method: init.method, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
  };

  it('channels are off until enabled and each one is configured; nothing is attempted when off', async () => {
    const off = new VeltrixMessagingAdapter(config({ VELTRIX_ENABLED: false }));
    expect(['EMAIL', 'SMS', 'WHATSAPP'].map((c) => off.channelEnabled(c as never))).toEqual([false, false, false]);
    await expect(off.sendSms({ to: '+2348031234567', text: 'x', idempotencyKey: 'k' })).rejects.toBeInstanceOf(MessagingNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
    const noSms = new VeltrixMessagingAdapter(config({ VELTRIX_SMS_SENDER: undefined }));
    expect(noSms.channelEnabled('SMS')).toBe(false);
    expect(noSms.channelEnabled('EMAIL')).toBe(true);
  });

  it('WhatsApp forwarding: PUT /whatsapp-servers/{uid}/forwarding with a rotated secret; templates of the platform number only', async () => {
    const a = new VeltrixMessagingAdapter(config());
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { record: { url: 'https://api.test/api/v1/whatsapp/webhook', enabled: true, secret: 'whfwd_abc' } } }));
    expect(await a.configureWhatsappForwarding('https://api.test/api/v1/whatsapp/webhook')).toEqual({ secret: 'whfwd_abc' });
    expect(last()).toMatchObject({ url: 'https://veltrix.test/api/v1/whatsapp-servers/wa123/forwarding', method: 'PUT', body: { url: 'https://api.test/api/v1/whatsapp/webhook', enabled: true, forward_statuses: true, rotate_secret: true } });
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { record: { url: 'x', enabled: true } } }));
    await expect(a.configureWhatsappForwarding('x')).rejects.toBeInstanceOf(MessagingUnavailableError); // no secret back

    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { records: [
      { server_uid: 'other', templates: [{ name: 'nope', language: 'en', category: 'UTILITY', params: 1, header: '' }] },
      { server_uid: 'wa123', templates: [{ name: 'ls_paid', language: 'en', category: 'UTILITY', params: 5, header: '', named: false }, { name: 'promo', language: 'en', category: 'MARKETING', params: 1, header: 'image', named: true }] },
    ] } }));
    expect(await a.whatsappTemplates()).toEqual([
      { name: 'ls_paid', language: 'en', category: 'UTILITY', params: 5, header: null, named: false },
      { name: 'promo', language: 'en', category: 'MARKETING', params: 1, header: 'image', named: true },
    ]);
    expect(last()).toMatchObject({ url: 'https://veltrix.test/api/v1/whatsapp/senders', method: 'GET' });
  });

  it('email: /transactional-emails with the API key and Idempotency-Key; returns the email uid', async () => {
    const a = new VeltrixMessagingAdapter(config());
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { record: { email_uid: 'em1', status: 'sent' } } }));
    const r = await a.sendEmail({ to: 'ada@example.com', toName: 'Ada', subject: 'Hi', html: '<p>x</p>', idempotencyKey: 'ls-1-0' });
    expect(r).toEqual({ providerMessageId: 'em1', replayed: false });
    expect(last()).toMatchObject({ url: 'https://veltrix.test/api/v1/transactional-emails', method: 'POST', headers: { 'X-MW-PUBLIC-KEY': ENV.VELTRIX_API_KEY, 'Idempotency-Key': 'ls-1-0' } });
    expect(last().body).toEqual({ to_email: 'ada@example.com', to_name: 'Ada', subject: 'Hi', body: '<p>x</p>', from_email: 'hello@livesell.africa', from_name: 'LiveSell Africa' });
  });

  it('email that Veltrix tried and failed (500 + record.status=error) is a definite failure; a plain 500 is not', async () => {
    const a = new VeltrixMessagingAdapter(config());
    fetchMock.mockImplementationOnce(() => json(500, { status: 'error', data: { record: { email_uid: 'em2', status: 'error' } } }));
    const e1 = await a.sendEmail({ to: 'a@b.ng', subject: 's', html: 'h', idempotencyKey: 'k' }).catch((e) => e);
    expect(e1).toBeInstanceOf(MessagingUnavailableError);
    expect(e1.definite).toBe(true);
    fetchMock.mockImplementationOnce(() => json(502, { status: 'error', error: 'bad gateway' }));
    const e2 = await a.sendEmail({ to: 'a@b.ng', subject: 's', html: 'h', idempotencyKey: 'k' }).catch((e) => e);
    expect(e2).toBeInstanceOf(MessagingUnavailableError);
    expect(e2.definite).toBe(false);
  });

  it('SMS: quick-send with the approved sender; message id from results; gateway refusal is permanent', async () => {
    const a = new VeltrixMessagingAdapter(config());
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { sent: 1, failed: 0, recipients: 1, results: [{ recipient: '2348031234567', status: 'sent', message_id: 'sms-9', error: null }] } }, { 'Idempotent-Replayed': 'true' }));
    expect(await a.sendSms({ to: '+2348031234567', text: 'Your code is 123456', idempotencyKey: 'k2' })).toEqual({ providerMessageId: 'sms-9', replayed: true });
    expect(last()).toMatchObject({ url: 'https://veltrix.test/api/v1/sms-tools/quick-send', body: { sender: 'LIVESELL', message: 'Your code is 123456', recipients: '+2348031234567' } });
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { sent: 0, failed: 1, recipients: 1, results: [{ recipient: 'x', status: 'failed', message_id: null, error: 'DND' }] } }));
    await expect(a.sendSms({ to: '+2348031234567', text: 'x', idempotencyKey: 'k3' })).rejects.toMatchObject({ code: 'SMS_REJECTED', message: 'DND' });
    fetchMock.mockImplementationOnce(() => json(402, { status: 'error', error: 'Insufficient wallet balance.' }));
    await expect(a.sendSms({ to: '+2348031234567', text: 'x', idempotencyKey: 'k4' })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    fetchMock.mockImplementationOnce(() => json(403, { status: 'error', error: 'SMS is not enabled for your account.' }));
    await expect(a.sendSms({ to: '+2348031234567', text: 'x', idempotencyKey: 'k5' })).rejects.toMatchObject({ code: 'CHANNEL_DISABLED' });
  });

  it('WhatsApp: text or approved template on the platform number; "|" in values cannot break the template', async () => {
    const a = new VeltrixMessagingAdapter(config());
    fetchMock.mockImplementation(() => json(200, { status: 'success', data: { message_id: 'wamid.1', phone: '2348031234567' } }));
    await a.sendWhatsapp({ to: '+2348031234567', text: 'Hello', idempotencyKey: 'w1' });
    expect(last()).toMatchObject({ url: 'https://veltrix.test/api/v1/whatsapp/send', body: { server_uid: 'wa123', phone: '+2348031234567', message_type: 'text', message: 'Hello' } });
    const r = await a.sendWhatsapp({ to: '+2348031234567', template: { name: 'order_confirmed', language: 'en', params: ['Ada', 'LS-7K3QXP', 'A|B'] }, idempotencyKey: 'w2' });
    expect(r.providerMessageId).toBe('wamid.1');
    expect(last().body).toMatchObject({ message_type: 'template', template_name: 'order_confirmed', template_language: 'en', template_params: 'Ada|LS-7K3QXP|A/B' });
  });

  it('outages and in-progress retries are temporary; a bad key is permanent', async () => {
    const a = new VeltrixMessagingAdapter(config());
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(a.sendSms({ to: '+2348031234567', text: 'x', idempotencyKey: 'k' })).rejects.toBeInstanceOf(MessagingUnavailableError);
    fetchMock.mockImplementationOnce(() => json(409, { status: 'error', error: 'still being processed' }));
    await expect(a.sendSms({ to: '+2348031234567', text: 'x', idempotencyKey: 'k' })).rejects.toBeInstanceOf(MessagingUnavailableError);
    fetchMock.mockImplementationOnce(() => json(401, { status: 'error', error: 'Invalid or inactive API key.' }));
    await expect(a.sendSms({ to: '+2348031234567', text: 'x', idempotencyKey: 'k' })).rejects.toBeInstanceOf(MessagingRejectedError);
  });

  it('SMS delivery receipts come from the send log filtered by message id', async () => {
    const a = new VeltrixMessagingAdapter(config());
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { records: [{ status: 'delivered' }], total: 1 } }));
    expect(await a.smsDelivery('sms-9')).toBe('DELIVERED');
    expect(last().url).toBe('https://veltrix.test/api/v1/sms-tools/logs?message_id=sms-9&per_page=1');
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { records: [{ status: 'submitted' }] } }));
    expect(await a.smsDelivery('sms-9')).toBe('SENT');
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { records: [{ status: 'undelivered' }] } }));
    expect(await a.smsDelivery('sms-9')).toBe('FAILED');
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { records: [] } }));
    expect(await a.smsDelivery('sms-9')).toBe('UNKNOWN');
  });

  it('status reports the account and wallet without any secret', async () => {
    const a = new VeltrixMessagingAdapter(config());
    fetchMock
      .mockImplementationOnce(() => json(200, { status: 'success', data: { record: { first_name: 'LiveSell', last_name: 'Platform', email: 'ops@livesell.africa' } } }))
      .mockImplementationOnce(() => json(200, { status: 'success', data: { record: { balance: '15250.00', currency_id: 1, status: 'active' } } }));
    const s = await a.status();
    expect(s).toEqual({ configured: true, channels: { EMAIL: true, SMS: true, WHATSAPP: true }, account: { name: 'LiveSell Platform', email: 'ops@livesell.africa' }, wallet: { balance: '15250.00', currency: '1' } });
    expect(JSON.stringify(s)).not.toContain(String(ENV.VELTRIX_API_KEY));
  });
});

describe('VeltrixVerifyAdapter', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => { fetchMock = jest.spyOn(globalThis, 'fetch'); });
  afterEach(() => fetchMock.mockRestore());

  it('CAC check: partner credential as Bearer, name compared; statuses mapped', async () => {
    const v = new VeltrixVerifyAdapter(config());
    expect(v.enabled).toBe(true);
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { check: { id: 'chk_1', type: 'cac', status: 'success', matched: true, match_score: 96, name: 'ADA FASHION LTD', environment: 'sandbox' }, message: 'Verified' } }));
    const r = await v.checkBusiness({ type: 'cac', identifier: '1234567', name: 'Ada Fashion Ltd', idempotencyKey: 'bv1' });
    expect(r).toEqual({ status: 'VERIFIED', matched: true, matchScore: 96, registeredName: 'ADA FASHION LTD', checkId: 'chk_1', environment: 'sandbox', message: 'Verified' });
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe('https://veltrix.test/api/verify/v1/kyc/business');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer kid_1.secret', 'Idempotency-Key': 'bv1' });
    expect(JSON.parse(String(init.body))).toEqual({ type: 'cac', identifier: '1234567', name: 'Ada Fashion Ltd' });
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { check: { id: 'c2', status: 'success', matched: false, name: 'OTHER LTD' }, message: null } }));
    expect((await v.checkBusiness({ type: 'cac', identifier: '1', name: 'x', idempotencyKey: 'k' })).status).toBe('MISMATCH');
    fetchMock.mockImplementationOnce(() => json(200, { status: 'success', data: { check: { id: 'c3', status: 'not_found', matched: false, name: null }, message: 'No record' } }));
    expect((await v.checkBusiness({ type: 'cac', identifier: '1', name: 'x', idempotencyKey: 'k' })).status).toBe('NOT_FOUND');
    fetchMock.mockImplementationOnce(() => json(402, { status: 'error', error: 'no subscription' }));
    await expect(v.checkBusiness({ type: 'cac', identifier: '1', name: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(new VeltrixVerifyAdapter(config({ VELTRIX_VERIFY_KEY: undefined })).enabled).toBe(false);
  });
});
