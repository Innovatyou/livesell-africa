import { createHmac } from 'node:crypto';
import { customerEvent } from '../orders/orders.service';
import { ORDER_EVENTS, orderEmail, orderText, OrderVars, WHATSAPP_PARAMS, whatsappParams } from '../notifications/order-templates';
import { formatMinor } from './order-notifier.service';
import { DEFAULT_PREFERENCES, mergePreferences, planChannels, Recipient } from './preferences';
import { verifyVeltrixSignature } from './whatsapp-admin.service';
import { normalisePhone, parseAddress, parseMessage } from './whatsapp-commerce.service';

const vars: OrderVars = {
  customerName: 'Amaka Nnaji', storeName: 'Ada <Fashion>', orderReference: 'LS-ABC123', total: '₦25,000', link: 'https://app.test/store/ada/order/LS-ABC123?token=t',
  items: [{ name: 'Bag <b>', quantity: 1, lineTotal: '₦25,000' }], holdUntil: '7 Nov, 3:00 pm', note: null, refundAmount: '₦5,000', storeWhatsapp: null,
};
const who = (over: Partial<Recipient> = {}): Recipient => ({ phone: '+2348031234567', email: 'a@example.com', whatsappOptIn: true, whatsappOptedOut: false, smsOptOut: false, ...over });
const ctx = (over: Partial<{ inWindow: boolean; hasTemplate: boolean; enabled: { WHATSAPP: boolean; SMS: boolean; EMAIL: boolean } }> = {}) =>
  ({ inWindow: false, hasTemplate: true, enabled: { WHATSAPP: true, SMS: true, EMAIL: true }, ...over });

describe('channel plan', () => {
  it('WhatsApp free text inside the 24-hour window, the approved template outside it', () => {
    expect(planChannels('PAYMENT_RECEIVED', DEFAULT_PREFERENCES, who(), ctx({ inWindow: true }))).toMatchObject({ whatsapp: 'text', sms: false, email: true });
    expect(planChannels('PAYMENT_RECEIVED', DEFAULT_PREFERENCES, who(), ctx())).toMatchObject({ whatsapp: 'template', sms: false });
  });

  it('falls back to SMS when WhatsApp cannot be used, and says why', () => {
    const noTemplate = planChannels('ORDER_DISPATCHED', DEFAULT_PREFERENCES, who(), ctx({ hasTemplate: false }));
    expect(noTemplate).toMatchObject({ whatsapp: null, sms: true, email: false });
    expect(noTemplate.skipped).toContain('whatsapp: outside the 24-hour window and no approved template');
    expect(planChannels('ORDER_DISPATCHED', DEFAULT_PREFERENCES, who({ whatsappOptIn: false }), ctx())).toMatchObject({ whatsapp: null, sms: true });
    const out = planChannels('ORDER_DISPATCHED', DEFAULT_PREFERENCES, who({ whatsappOptedOut: true }), ctx());
    expect(out).toMatchObject({ whatsapp: null, sms: true });
    expect(out.skipped).toContain('whatsapp: customer opted out');
  });

  it('respects SMS opt-out, missing contact details, disabled channels and the store switch', () => {
    expect(planChannels('ORDER_DISPATCHED', DEFAULT_PREFERENCES, who({ whatsappOptIn: false, smsOptOut: true }), ctx())).toMatchObject({ whatsapp: null, sms: false });
    expect(planChannels('ORDER_PLACED', DEFAULT_PREFERENCES, who({ email: null }), ctx()).email).toBe(false);
    expect(planChannels('ORDER_PLACED', DEFAULT_PREFERENCES, who(), ctx({ enabled: { WHATSAPP: false, SMS: false, EMAIL: true } }))).toMatchObject({ whatsapp: null, sms: false, email: true });
    const off = planChannels('ORDER_PLACED', { ...DEFAULT_PREFERENCES, enabled: false }, who(), ctx());
    expect(off).toMatchObject({ whatsapp: null, sms: false, email: false, skipped: ['store has automatic messages off'] });
    const noSms = mergePreferences({ events: { ORDER_DISPATCHED: { sms: false } } });
    expect(planChannels('ORDER_DISPATCHED', noSms, who({ whatsappOptIn: false }), ctx())).toMatchObject({ whatsapp: null, sms: false });
  });

  it('preferences merge over defaults; junk is ignored', () => {
    const p = mergePreferences({ enabled: 'yes', paymentReminderHoursBefore: 500, abandonedAfterMinutes: 30, events: { ORDER_PLACED: { email: false, whatsapp: 'x' }, NOPE: { sms: true } } });
    expect(p.enabled).toBe(true);
    expect(p.paymentReminderHoursBefore).toBe(6);
    expect(p.abandonedAfterMinutes).toBe(30);
    expect(p.events.ORDER_PLACED).toEqual({ whatsapp: true, sms: true, email: false });
    expect(Object.keys(p.events)).toEqual([...ORDER_EVENTS]);
    expect(mergePreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });
});

describe('order events', () => {
  it('maps status changes to the customer event (only real changes the customer cares about)', () => {
    expect(customerEvent(null, 'PENDING_PAYMENT')).toBe('ORDER_PLACED');
    expect(customerEvent('DRAFT', 'PENDING_PAYMENT')).toBe('ORDER_PLACED');
    expect(customerEvent('PENDING_PAYMENT', 'PAID')).toBe('PAYMENT_RECEIVED');
    expect(customerEvent('PAYMENT_VERIFICATION', 'PENDING_PAYMENT')).toBe('TRANSFER_NOT_FOUND');
    expect(customerEvent('PENDING_PAYMENT', 'PAYMENT_VERIFICATION')).toBe('TRANSFER_REPORTED');
    expect(customerEvent('READY_FOR_DISPATCH', 'DISPATCHED')).toBe('ORDER_DISPATCHED');
    expect(customerEvent('PAID', 'PROCESSING')).toBeNull();
    expect(customerEvent(null, 'DRAFT')).toBeNull();
  });

  it('every event has text, an email and template values in a fixed order', () => {
    for (const e of ORDER_EVENTS) {
      expect(orderText(e, vars)).toContain('LS-ABC123');
      const m = orderEmail(e, vars);
      expect(m.subject).toContain(e === 'ABANDONED_CHECKOUT' ? 'Ada <Fashion>' : 'LS-ABC123');
      expect(m.html).not.toContain('<Fashion>');
      expect(m.html).toContain('Ada &lt;Fashion&gt;');
      expect(whatsappParams(e, vars)).toHaveLength(WHATSAPP_PARAMS[e].length);
    }
    expect(whatsappParams('ORDER_DISPATCHED', vars)[3]).toBe('-'); // empty values never break a template
    expect(orderEmail('PAYMENT_RECEIVED', vars).html).toContain('Bag &lt;b&gt;');
  });

  it('formats kobo exactly', () => {
    expect(formatMinor(2500000n)).toBe('₦25,000');
    expect(formatMinor('123456789')).toBe('₦1,234,567.89');
    expect(formatMinor(5n, 'USD')).toBe('USD 0.05');
  });
});

describe('WhatsApp ordering parser', () => {
  it('finds the product code and the store words', () => {
    expect(parseMessage('ada-fashion BAG001')).toMatchObject({ candidates: ['ada-fashion', 'bag001'], codes: ['BAG001'], command: null });
    expect(parseMessage('ORDER adafashion bag001')).toMatchObject({ candidates: ['adafashion', 'bag001'], codes: ['BAG001'] });
    expect(parseMessage('shop24 BAG001').codes).toEqual(['SHOP24', 'BAG001']); // the service resolves shop24 as the store
    expect(parseMessage('I want BAG-001 please!')).toMatchObject({ codes: ['BAG-001'], candidates: ['bag-001'] });
    expect(parseMessage('stop').command).toBe('STOP');
    expect(parseMessage('  Yes please ').command).toBe('YES');
    expect(parseMessage('hello').codes).toEqual([]);
  });

  it('reads addresses as street, city, state', () => {
    expect(parseAddress('12 Allen Avenue, Ikeja, Lagos')).toEqual({ line1: '12 Allen Avenue', city: 'Ikeja', state: 'Lagos' });
    expect(parseAddress('Flat 2, 12 Allen Avenue, Ikeja, Lagos')).toEqual({ line1: 'Flat 2, 12 Allen Avenue', city: 'Ikeja', state: 'Lagos' });
    expect(parseAddress('Ikeja Lagos')).toBeNull();
  });

  it('normalises phone numbers', () => {
    expect(normalisePhone('2348031234567')).toBe('+2348031234567');
    expect(normalisePhone('08031234567')).toBe('+2348031234567');
    expect(normalisePhone('+234 803 123 4567')).toBe('+2348031234567');
    expect(normalisePhone('12')).toBeNull();
  });
});

describe('forward signature', () => {
  const secret = 'whfwd_secret';
  const body = Buffer.from('{"event":"message.received"}');
  const sign = (t: number, b = body, s = secret) => `t=${t},v1=${createHmac('sha256', s).update(`${t}.`).update(b).digest('hex')}`;
  const now = 1_800_000_000_000;

  it('accepts a fresh, correct signature', () => {
    expect(verifyVeltrixSignature(secret, body, sign(now / 1000), now)).toBe(true);
  });
  it('rejects a wrong secret, a changed body, an old timestamp and garbage', () => {
    expect(verifyVeltrixSignature(secret, body, sign(now / 1000, body, 'other'), now)).toBe(false);
    expect(verifyVeltrixSignature(secret, Buffer.from('{}'), sign(now / 1000), now)).toBe(false);
    expect(verifyVeltrixSignature(secret, body, sign(now / 1000 - 301), now)).toBe(false);
    expect(verifyVeltrixSignature(secret, body, 'nonsense', now)).toBe(false);
    expect(verifyVeltrixSignature(secret, body, undefined, now)).toBe(false);
  });
});
