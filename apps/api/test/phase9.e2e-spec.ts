import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { OrderNotifier } from '../src/automation/order-notifier.service';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { configureApp } from '../src/configure-app';
import { MessagingProvider } from '../src/messaging/messaging-provider';
import { PaymentProviderRegistry } from '../src/payments/payment-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer, FakeMessaging, FakePaymentProvider, FakeRegistry } from './support';

const PASSWORD = 'CorrectHorse42';
const SECRET = 'whfwd_test_forwarding_secret_0123456789'; // what FakeMessaging.configureWhatsappForwarding returns
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
type H = Record<string, string>;
const WA_KEYS = ['whatsapp.forwarding', 'whatsapp.templates', 'whatsapp.platform_number'];

describe('Phase 9 — automatic order messages and WhatsApp ordering', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifier: OrderNotifier;
  let http: ReturnType<typeof request>;
  const fake = new FakeMessaging();
  let adminH: H;
  let saved: Array<{ key: string; value: unknown }> = [];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer).useValue(new CapturingMailer())
      .overrideProvider(BillingNotifier).useValue(new CapturingBillingNotifier())
      .overrideProvider(MessagingProvider).useValue(fake)
      .overrideProvider(PaymentProviderRegistry).useValue(new FakeRegistry(new FakePaymentProvider('PAYSTACK')))
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    notifier = app.get(OrderNotifier);
    http = request(app.getHttpServer());
    saved = (await prisma.platformSetting.findMany({ where: { key: { in: WA_KEYS } } })).map((s) => ({ key: s.key, value: s.value }));
    await prisma.platformSetting.deleteMany({ where: { key: { in: WA_KEYS } } });
    adminH = await admin();
  });
  afterAll(async () => {
    await prisma.platformSetting.deleteMany({ where: { key: { in: WA_KEYS } } });
    for (const s of saved) await prisma.platformSetting.create({ data: { key: s.key, value: s.value as object } });
    await app.close();
  });
  beforeEach(() => {
    fake.enabled = { EMAIL: true, SMS: true, WHATSAPP: true };
    fake.next = { EMAIL: [], SMS: [], WHATSAPP: [] };
    fake.templates = [];
  });

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p9-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p9-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { email: body.email, slug: body.storeUsername, businessName: body.businessName, tenantId: res.body.tenant.id as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } as H };
  }
  async function admin(): Promise<H> {
    const a = await register();
    await prisma.user.update({ where: { email: a.email }, data: { platformRole: 'PLATFORM_ADMIN' } });
    return { Authorization: a.h.Authorization };
  }
  async function member(tenantId: string, roleKey: string): Promise<H> {
    const other = await register();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId, key: roleKey } });
    const m = await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    await prisma.tenantMember.create({ data: { tenantId, userId: m.userId, roleId: role.id } });
    return { Authorization: other.h.Authorization, 'X-Tenant-Id': tenantId };
  }
  /** Published store with BAG001 ₦25,000 × 5 and a transfer account. */
  async function store() {
    const s = await register();
    const bag = (await http.post('/api/v1/products').set(s.h).send({
      name: 'Leather Bag', productCode: 'BAG001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '2500000', initialStock: 5 }],
    }).expect(201)).body;
    await http.patch('/api/v1/store/profile').set(s.h).send({ description: 'Bags', whatsappNumber: '+2348031234567' }).expect(200);
    await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
    await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankName: 'Guaranty Trust Bank', accountNumber: '0123456789', accountName: 'ADA FASHION LTD' }).expect(201);
    return { ...s, variantId: bag.variants[0].id as string };
  }
  async function checkout(s: { slug: string; variantId: string }, opts: { optIn?: boolean; email?: string | null; phone?: string } = {}) {
    const p = opts.phone ?? phone();
    const r = await http.post(`/api/v1/store/${s.slug}/checkout`).send({
      customer: { fullName: 'Amaka Nnaji', phone: p, ...(opts.email === null ? {} : { email: opts.email ?? `buyer-${uniq()}@example.com` }) },
      items: [{ variantId: s.variantId, quantity: 1 }], shippingAddress: { line1: '3 Bode Thomas', city: 'Surulere', state: 'Lagos' },
      ...(opts.optIn ? { whatsappOptIn: true } : {}),
    }).expect(201);
    const o = await prisma.order.findFirstOrThrow({ where: { reference: r.body.reference } });
    return { reference: r.body.reference as string, token: r.body.trackingToken as string, id: o.id, phone: p, customerId: o.customerId! };
  }
  /** Run the outbox job until nothing is left (other suites' rows included). */
  async function drain() {
    for (let i = 0; i < 20; i++) {
      const r = await notifier.dispatchOutbox(200);
      if (r.due < 200) return;
    }
  }
  const sentTo = (to: string) => fake.sent.filter((m) => m.to === to);
  const rows = (orderId: string) => prisma.notification.findMany({ where: { dedupeKey: { startsWith: `order:${orderId}:` } }, orderBy: { createdAt: 'asc' } });
  const payByTransfer = async (s: { slug: string; h: H }, o: { id: string; reference: string; token: string }) => {
    const claim = (await http.post(`/api/v1/store/${s.slug}/orders/${o.reference}/transfer`).send({ token: o.token, payerName: 'Amaka Nnaji', payerBank: 'Access Bank', payerReference: `0000${uniq()}` }).expect(200)).body;
    await http.post(`/api/v1/orders/${o.id}/transfers/${claim.id}/verify`).set(s.h).send({ amountReceivedMinor: '2500000' }).expect(200);
  };

  function sign(body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) {
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  }
  function deliver(event: string, data: Record<string, unknown>, o: { sig?: string; delivery?: string } = {}) {
    const body = JSON.stringify({ event, created_at: new Date().toISOString(), data });
    return http.post('/api/v1/whatsapp/webhook').set('Content-Type', 'application/json')
      .set('X-Veltrix-Event', event).set('X-Veltrix-Signature', o.sig ?? sign(body)).set('X-Veltrix-Delivery', o.delivery ?? randomBytes(16).toString('hex')).send(body);
  }
  /** The customer sends a WhatsApp message; returns the replies LiveSell sent back. */
  async function say(from: string, text: string) {
    const before = fake.sent.length;
    await deliver('message.received', { server_uid: 'srv1', from: from.slice(1), name: 'Amaka', type: 'text', text, wa_message_id: `wamid.in.${uniq()}` }).expect(200);
    return fake.sent.slice(before).filter((m) => m.channel === 'WHATSAPP' && m.to === from).map((m) => m.text ?? '');
  }
  const connect = () => http.post('/api/v1/admin/whatsapp/forwarding').set(adminH).expect(200);

  // ───────────────────────── Order messages ─────────────────────────
  describe('order messages from the outbox', () => {
    it('online order: SMS + email invoice once, with a private link that works; no WhatsApp without opt-in', async () => {
      const s = await store();
      const o = await checkout(s);
      const ev = await prisma.outboxEvent.findMany({ where: { entityId: o.id } });
      expect(ev).toEqual([expect.objectContaining({ type: 'ORDER_PLACED', tenantId: s.tenantId, processedAt: null })]);
      await drain();
      await drain();
      const out = sentTo(o.phone);
      expect(out.map((m) => m.channel)).toEqual(['SMS']);
      expect(out[0].text).toContain(o.reference);
      const link = /(https?:\/\/\S+)/.exec(out[0].text!)![1];
      const token = new URL(link).searchParams.get('token')!;
      expect(token).toBe(o.token);
      await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${encodeURIComponent(token)}`).expect(200);
      const mail = fake.sent.filter((m) => m.channel === 'EMAIL' && m.subject?.includes(o.reference));
      expect(mail).toHaveLength(1);
      expect(mail[0].html).toContain(`Invoice — ${o.reference}`);
      const r = await rows(o.id);
      expect(r.map((x) => `${x.channel}:${x.status}`).sort()).toEqual(['EMAIL:SENT', 'SMS:SENT']);
      expect(r.every((x) => x.tenantId === s.tenantId)).toBe(true);
      expect((await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: o.id } })).processedAt).not.toBeNull();
      // The seller sees the messages on the order (and the cost).
      const list = (await http.get(`/api/v1/orders/${o.id}/notifications`).set(s.h).expect(200)).body;
      expect(list).toHaveLength(2);
      const other = await store();
      expect((await http.get(`/api/v1/orders/${o.id}/notifications`).set(other.h).expect(200)).body).toEqual([]);
    });

    it('opted-in customer: WhatsApp template outside the 24-hour window, free text inside it; payment confirmation after verification', async () => {
      const s = await store();
      fake.templates = [
        { name: 'ls_order_placed', language: 'en', status: 'APPROVED', category: 'UTILITY', params: 5, header: null },
        { name: 'ls_paid', language: 'en', status: 'APPROVED', category: 'UTILITY', params: 5, header: null },
        { name: 'ls_wrong', language: 'en', status: 'APPROVED', category: 'UTILITY', params: 2, header: null },
        { name: 'ls_named', language: 'en', status: 'APPROVED', category: 'UTILITY', params: 5, header: null, named: true },
      ] as never;
      // Admin mapping is validated against the approved templates.
      await http.put('/api/v1/admin/whatsapp').set(adminH).send({ templates: { ORDER_PLACED: { name: 'missing', language: 'en' } } }).expect(400);
      expect((await http.put('/api/v1/admin/whatsapp').set(adminH).send({ templates: { PAYMENT_RECEIVED: { name: 'ls_wrong', language: 'en' } } }).expect(400)).body.message).toContain('takes 2 value(s)');
      expect((await http.put('/api/v1/admin/whatsapp').set(adminH).send({ templates: { ORDER_PLACED: { name: 'ls_named', language: 'en' } } }).expect(400)).body.message).toContain('named values');
      await http.put('/api/v1/admin/whatsapp').set(adminH).send({ templates: { ORDER_PLACED: { name: 'ls_order_placed', language: 'en' }, PAYMENT_RECEIVED: { name: 'ls_paid', language: 'en' } } }).expect(200);

      const o = await checkout(s, { optIn: true, email: null });
      expect(await prisma.customer.findUniqueOrThrow({ where: { id: o.customerId } })).toMatchObject({ whatsappOptIn: true });
      await drain();
      let out = sentTo(o.phone);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ channel: 'WHATSAPP', template: { name: 'ls_order_placed', language: 'en' } });
      expect(out[0].template!.params.slice(0, 3)).toEqual(['Amaka Nnaji', s.businessName, o.reference]);
      expect(out[0].template!.params[4]).toContain(`token=${encodeURIComponent(o.token)}`);

      // TRANSFER_REPORTED is WhatsApp-only by default and has no template → skipped (not SMS).
      // The customer then writes to the platform number, so the window opens and free text is used.
      await prisma.whatsappConversation.create({ data: { phone: o.phone, lastInboundAt: new Date(), windowStart: new Date() } });
      await payByTransfer(s, o);
      await drain();
      out = sentTo(o.phone);
      const paid = out.filter((m) => m.text?.includes('is confirmed'));
      expect(paid).toHaveLength(1);
      expect(paid[0]).toMatchObject({ channel: 'WHATSAPP', template: undefined });
      expect(out.filter((m) => m.channel === 'SMS')).toHaveLength(0);
    });

    it('dispatch, delivery and cancellation messages follow the store’s preferences', async () => {
      const s = await store();
      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.get('/api/v1/notifications/preferences').set(assistant).expect(403);
      const prefs = (await http.get('/api/v1/notifications/preferences').set(s.h).expect(200)).body;
      expect(prefs).toMatchObject({ enabled: true, paymentReminderHoursBefore: 6, abandonedAfterMinutes: 60 });
      const saved = (await http.put('/api/v1/notifications/preferences').set(s.h).send({ ...prefs, events: { ...prefs.events, ORDER_DELIVERED: { whatsapp: false, sms: false, email: false } } }).expect(200)).body;
      expect(saved.events.ORDER_DELIVERED).toEqual({ whatsapp: false, sms: false, email: false });

      const o = await checkout(s, { email: null });
      await payByTransfer(s, o);
      await http.post(`/api/v1/orders/${o.id}/status`).set(s.h).send({ status: 'DISPATCHED', note: 'GIG Logistics' }).expect(200);
      await http.post(`/api/v1/orders/${o.id}/status`).set(s.h).send({ status: 'DELIVERED' }).expect(200);
      await drain();
      const texts = sentTo(o.phone).map((m) => m.text!);
      expect(texts.some((t) => t.includes('has sent out order') && t.includes('GIG Logistics'))).toBe(true);
      expect(texts.some((t) => t.includes('marked delivered'))).toBe(false);

      // Store switch off: nothing more goes out.
      await http.put('/api/v1/notifications/preferences').set(s.h).send({ enabled: false }).expect(200);
      const o2 = await checkout(s, { email: null });
      await drain();
      expect(sentTo(o2.phone)).toHaveLength(0);
      expect((await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: o2.id } })).processedAt).not.toBeNull();
    });

    it('a messaging outage never blocks the order; the message is retried, and an order event is never sent twice', async () => {
      const s = await store();
      fake.next.SMS = ['unavailable'];
      const o = await checkout(s, { email: null });
      await drain();
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('PENDING_PAYMENT');
      const [row] = await rows(o.id);
      expect(row).toMatchObject({ channel: 'SMS', status: 'QUEUED', attempts: 1 });
      await notifier.notify(s.tenantId, o.id, 'ORDER_PLACED'); // replay of the same event
      expect(await rows(o.id)).toHaveLength(1);
    });
  });

  // ───────────────────────── Reminders ─────────────────────────
  describe('reminders', () => {
    it('payment reminder before the hold ends and the abandoned-checkout nudge, each once', async () => {
      const s = await store();
      const o = await checkout(s, { email: null });
      await drain();
      await prisma.order.update({ where: { id: o.id }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000), reservationExpiresAt: new Date(Date.now() + 3 * 3_600_000) } });
      await notifier.runReminders(new Date());
      await notifier.runReminders(new Date());
      const texts = sentTo(o.phone).map((m) => m.text!);
      expect(texts.filter((t) => t.includes('is waiting for payment'))).toHaveLength(1);
      expect(texts.filter((t) => t.includes('you left order'))).toHaveLength(1);
      // A paid order gets no reminders.
      const paid = await checkout(s, { email: null });
      await payByTransfer(s, paid);
      await prisma.order.update({ where: { id: paid.id }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
      const before = sentTo(paid.phone).length;
      await notifier.runReminders(new Date());
      expect(sentTo(paid.phone).filter((m) => m.text?.includes('waiting for payment'))).toHaveLength(0);
      expect(sentTo(paid.phone).length).toBe(before);
    });

    it('seller sends a reminder by hand: members only, at most every 6 hours, only for unpaid orders, own store only', async () => {
      const s = await store();
      const o = await checkout(s, { email: null });
      const outsider = await register();
      await http.post(`/api/v1/orders/${o.id}/notify`).set({ Authorization: outsider.h.Authorization, 'X-Tenant-Id': s.tenantId }).send({ event: 'PAYMENT_REMINDER' }).expect(403);
      const r = (await http.post(`/api/v1/orders/${o.id}/notify`).set(s.h).send({ event: 'PAYMENT_REMINDER' }).expect(200)).body;
      expect(r.results).toEqual([expect.objectContaining({ channel: 'SMS', status: 'SENT' })]);
      await http.post(`/api/v1/orders/${o.id}/notify`).set(s.h).send({ event: 'PAYMENT_REMINDER' }).expect(409);
      await http.post(`/api/v1/orders/${o.id}/notify`).set(s.h).send({ event: 'ORDER_DELIVERED' }).expect(400);
      const other = await store();
      await http.post(`/api/v1/orders/${o.id}/notify`).set(other.h).send({ event: 'PAYMENT_REMINDER' }).expect(404);
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'order.reminder_sent', entityId: o.id } })).toBe(1);
      await payByTransfer(s, o);
      await http.post(`/api/v1/orders/${o.id}/notify`).set(s.h).send({ event: 'PAYMENT_REMINDER' }).expect(409);
    });
  });

  // ───────────────────────── Inbound webhook ─────────────────────────
  describe('inbound WhatsApp (Veltrix forwarding)', () => {
    it('admin connects forwarding; the secret is stored encrypted; unsigned, wrongly signed or stale deliveries are refused', async () => {
      await deliver('message.received', { from: '2348031234567', text: 'hi', wa_message_id: 'wamid.x' }).expect(401); // not connected yet
      const s = await store();
      await http.post('/api/v1/admin/whatsapp/forwarding').set(s.h).expect(403);
      const res = (await connect()).body;
      expect(res.forwarding).toMatchObject({ connected: true, url: expect.stringMatching(/\/api\/v1\/whatsapp\/webhook$/) });
      expect(fake.forwardingUrl).toBe(res.forwarding.url);
      expect(JSON.stringify(res)).not.toContain(SECRET);
      expect(JSON.stringify((await prisma.platformSetting.findUniqueOrThrow({ where: { key: 'whatsapp.forwarding' } })).value)).not.toContain(SECRET);
      expect(await prisma.auditLog.count({ where: { action: 'platform.whatsapp_forwarding_connected' } })).toBeGreaterThan(0);

      const body = JSON.stringify({ event: 'message.received', data: { from: '2348031234567', text: 'hi' } });
      await deliver('message.received', { from: '2348031234567', text: 'hi' }, { sig: sign(body, undefined, 'wrong-secret') }).expect(401);
      await deliver('message.received', { from: '2348031234567', text: 'hi' }, { sig: 'garbage' }).expect(401);
      await deliver('message.received', { from: '2348031234567', text: 'hi' }, { sig: sign(body, Math.floor(Date.now() / 1000) - 600) }).expect(401);
      await http.post('/api/v1/whatsapp/webhook').set('Content-Type', 'application/json').send(body).expect(401);
    });

    it('a retried delivery (same WhatsApp message id) is handled once', async () => {
      await connect();
      const from = phone();
      const data = { from: from.slice(1), name: 'Amaka', text: 'HELP', wa_message_id: `wamid.dup.${uniq()}` };
      const first = (await deliver('message.received', data).expect(200)).body;
      const again = (await deliver('message.received', data).expect(200)).body;
      expect(first).toEqual({ processed: true });
      expect(again).toEqual({ duplicate: true });
      expect(sentTo(from).filter((m) => m.channel === 'WHATSAPP')).toHaveLength(1);
      expect(sentTo(from)[0].text).toContain('To order, send the product code');
    });

    it('delivery statuses update the message row', async () => {
      await connect();
      const s = await store();
      const o = await checkout(s, { optIn: true, email: null });
      await prisma.whatsappConversation.create({ data: { phone: o.phone, lastInboundAt: new Date(), windowStart: new Date() } });
      await drain();
      const [row] = (await rows(o.id)).filter((r) => r.channel === 'WHATSAPP');
      expect(row).toMatchObject({ status: 'SENT', providerMessageId: expect.stringMatching(/^wamid\./) });
      expect((await deliver('message.status', { wa_message_id: row.providerMessageId, status: 'delivered' }).expect(200)).body).toEqual({ processed: true, updated: 1 });
      expect(await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'DELIVERED' });
    });
  });

  // ───────────────────────── WhatsApp ordering ─────────────────────────
  describe('ordering in the WhatsApp conversation', () => {
    it('code → quantity → name → address → YES places a real order with a stock hold, a private link and transfer details', async () => {
      await connect();
      const s = await store();
      const from = phone();
      let r = await say(from, `${s.slug} BAG001`);
      expect(r[0]).toContain(`Welcome to ${s.businessName}! You selected Leather Bag`);
      expect(r[0]).toContain('₦25,000');
      expect((await say(from, '9'))[0]).toContain('Only 5 left');
      expect((await say(from, '2'))[0]).toBe('What is your full name?');
      expect((await say(from, 'Amaka Nnaji'))[0]).toContain('street, city, state');
      expect((await say(from, 'somewhere'))[0]).toContain('Please send the address');
      r = await say(from, '12 Allen Avenue, Ikeja, Lagos');
      expect(r[0]).toContain('2 × Leather Bag = ₦50,000');
      expect(r[0]).toContain('Deliver to: 12 Allen Avenue, Ikeja, Lagos');
      r = await say(from, 'YES');
      const o = await prisma.order.findFirstOrThrow({ where: { tenantId: s.tenantId }, orderBy: { createdAt: 'desc' }, include: { customer: true, channel: true, items: true } });
      expect(o).toMatchObject({ status: 'PENDING_PAYMENT', totalMinor: 5_000_000n, channel: { type: 'WHATSAPP' }, customer: { phone: from, fullName: 'Amaka Nnaji', whatsappOptIn: true } });
      expect(o.items).toEqual([expect.objectContaining({ quantity: 2, unitPriceMinor: 2_500_000n })]);
      expect(await prisma.inventory.findUniqueOrThrow({ where: { variantId: s.variantId } })).toMatchObject({ reserved: 2 });
      expect(r[0]).toContain(`Order ${o.reference} placed with ${s.businessName}`);
      expect(r[0]).toContain('Guaranty Trust Bank 0123456789');
      const link = /(https?:\/\/\S+token=\S+)/.exec(r[0])![1];
      const token = new URL(link).searchParams.get('token')!;
      await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${encodeURIComponent(token)}`).expect(200);

      // ORDER_PLACED is not repeated on WhatsApp/SMS (the conversation already answered).
      const before = sentTo(from).length;
      await drain();
      expect(sentTo(from).length).toBe(before);

      r = await say(from, 'STATUS');
      expect(r[0]).toContain(o.reference);
      expect(r[0]).toContain('awaiting payment');

      // Replies are attributed to the store once it is known (usage), not before.
      const replies = await prisma.notification.findMany({ where: { destination: from, type: 'WHATSAPP_REPLY' }, orderBy: { createdAt: 'asc' } });
      expect(replies.every((x) => x.tenantId === s.tenantId)).toBe(true);
    });

    it('delivery is priced by the store’s zones; pickup only where offered (Phase 10)', async () => {
      await connect();
      const s = await store();
      await http.post('/api/v1/delivery/zones').set(s.h).send({ name: 'Ikeja', states: ['Lagos'], cities: ['Ikeja'], feeMinor: '150000', etaDays: 1 }).expect(201);
      const from = phone();
      await say(from, `${s.slug} BAG001`);
      await say(from, '1');
      await say(from, 'Amaka Nnaji');
      expect((await say(from, 'PICKUP'))[0]).toContain('doesn’t offer pickup');
      const r = (await say(from, '12 Allen Avenue, Ikeja, Lagos'))[0];
      expect(r).toContain('Delivery (Ikeja): ₦1,500');
      expect(r).toContain('Total: ₦26,500');
      expect(r).toContain('Usually delivered within 1 day(s)');
      await say(from, 'YES');
      const o = await prisma.order.findFirstOrThrow({ where: { tenantId: s.tenantId }, include: { delivery: true } });
      expect(o).toMatchObject({ deliveryFeeMinor: 150_000n, totalMinor: 2_650_000n, delivery: { method: 'SELLER_DELIVERY', status: 'PENDING' } });
    });

    it('a store name without the code, CANCEL, NO and unknown codes', async () => {
      await connect();
      const s = await store();
      const from = phone();
      expect((await say(from, s.slug))[0]).toContain(`Welcome to ${s.businessName}`);
      expect((await say(from, 'NOPE99'))[0]).toContain("couldn't find NOPE99");
      expect((await say(from, 'BAG001'))[0]).toContain('How many');
      expect((await say(from, 'CANCEL'))[0]).toContain('Cancelled');
      expect((await say(from, 'hello'))[0]).toContain('To order, send the product code');
      expect(await prisma.order.count({ where: { tenantId: s.tenantId } })).toBe(0);
    });

    it('STOP opts the number out everywhere (SMS still works), START opts back in', async () => {
      await connect();
      const s = await store();
      const o = await checkout(s, { optIn: true, email: null });
      await drain();
      const r = await say(o.phone, 'STOP');
      expect(r[0]).toContain('won’t get WhatsApp messages');
      expect(await prisma.customer.findUniqueOrThrow({ where: { id: o.customerId } })).toMatchObject({ whatsappOptIn: false, whatsappOptOutAt: expect.any(Date) });
      expect(await say(o.phone, 'HELP')).toEqual([]); // silent while opted out
      await payByTransfer(s, o);
      await drain();
      const paid = sentTo(o.phone).filter((m) => m.text?.includes('is confirmed'));
      expect(paid.map((m) => m.channel)).toEqual(['SMS']);
      expect((await say(o.phone, 'START'))[0]).toContain('back on');
      expect(await prisma.customer.findUniqueOrThrow({ where: { id: o.customerId } })).toMatchObject({ whatsappOptIn: true, whatsappOptOutAt: null });
    });

    it('a store that is not published cannot be ordered from; the storefront says whether WhatsApp ordering is on', async () => {
      await connect();
      const s = await store();
      await http.put('/api/v1/admin/whatsapp').set(adminH).send({ platformNumber: '+2348000000009' }).expect(200);
      expect((await http.get(`/api/v1/store/${s.slug}/whatsapp-ordering`).expect(200)).body).toEqual({ enabled: true, number: '+2348000000009', prefix: s.slug });
      fake.enabled.WHATSAPP = false;
      expect((await http.get(`/api/v1/store/${s.slug}/whatsapp-ordering`).expect(200)).body).toMatchObject({ enabled: false, number: null });
      fake.enabled.WHATSAPP = true;
      await http.post('/api/v1/storefront/unpublish').set(s.h).expect(200);
      await http.get(`/api/v1/store/${s.slug}/whatsapp-ordering`).expect(404);
      const from = phone();
      const r = (await say(from, `${s.slug} BAG001`))[0];
      expect(r).not.toContain(s.businessName); // the unpublished store is never offered
      if (r.startsWith('Several stores')) expect((await say(from, s.slug))[0]).toContain('couldn’t find that store');
      expect(await prisma.order.count({ where: { tenantId: s.tenantId } })).toBe(0);
    });
  });
});
