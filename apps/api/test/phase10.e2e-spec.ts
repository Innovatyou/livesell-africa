import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { configureApp } from '../src/configure-app';
import { PaymentProviderRegistry } from '../src/payments/payment-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer, FakePaymentProvider, FakeRegistry } from './support';

const PASSWORD = 'CorrectHorse42';
const DAY = 86_400_000;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
type H = Record<string, string>;
const binary = (res: NodeJS.ReadableStream & { setEncoding: (e: string) => void }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Phase 10 — logistics, analytics and reports', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer).useValue(new CapturingMailer())
      .overrideProvider(BillingNotifier).useValue(new CapturingBillingNotifier())
      .overrideProvider(PaymentProviderRegistry).useValue(new FakeRegistry(new FakePaymentProvider('PAYSTACK')))
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p10-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p10-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { slug: body.storeUsername, businessName: body.businessName, tenantId: res.body.tenant.id as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } as H };
  }
  async function member(tenantId: string, roleKey: string): Promise<H> {
    const other = await register();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId, key: roleKey } });
    const m = await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    await prisma.tenantMember.create({ data: { tenantId, userId: m.userId, roleId: role.id } });
    return { Authorization: other.h.Authorization, 'X-Tenant-Id': tenantId };
  }
  /** Published store with BAG001 ₦25,000 × 20 and a transfer account. */
  async function store() {
    const s = await register();
    const bag = (await http.post('/api/v1/products').set(s.h).send({
      name: 'Leather Bag', productCode: 'BAG001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '2500000', initialStock: 20 }],
    }).expect(201)).body;
    await http.patch('/api/v1/store/profile').set(s.h).send({ description: 'Bags', whatsappNumber: '+2348031234567' }).expect(200);
    await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
    await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankName: 'Guaranty Trust Bank', accountNumber: '0123456789', accountName: 'ADA FASHION LTD' }).expect(201);
    return { ...s, variantId: bag.variants[0].id as string };
  }
  const ikeja = { line1: '3 Allen Avenue', city: 'Ikeja', state: 'Lagos' };
  async function checkout(s: { slug: string; variantId: string }, opts: { address?: object | null; method?: 'DELIVERY' | 'PICKUP'; phone?: string; qty?: number } = {}) {
    const r = await http.post(`/api/v1/store/${s.slug}/checkout`).send({
      customer: { fullName: 'Amaka Nnaji', phone: opts.phone ?? phone() }, items: [{ variantId: s.variantId, quantity: opts.qty ?? 1 }],
      ...(opts.address === null ? {} : { shippingAddress: opts.address ?? ikeja }), ...(opts.method ? { deliveryMethod: opts.method } : {}),
    });
    if (r.status !== 201) return { res: r } as never;
    const o = await prisma.order.findFirstOrThrow({ where: { reference: r.body.reference } });
    return { res: r, reference: r.body.reference as string, token: r.body.trackingToken as string, id: o.id, total: o.totalMinor, order: o };
  }
  async function pay(s: { slug: string; h: H }, o: { id: string; reference: string; token: string }) {
    const t = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    const claim = (await http.post(`/api/v1/store/${s.slug}/orders/${o.reference}/transfer`).send({ token: o.token, payerName: 'Amaka Nnaji', payerBank: 'Access Bank', payerReference: `0000${uniq()}` }).expect(200)).body;
    await http.post(`/api/v1/orders/${o.id}/transfers/${claim.id}/verify`).set(s.h).send({ amountReceivedMinor: t.totalMinor.toString() }).expect(200);
  }
  async function payStaff(s: { h: H }, orderId: string) {
    const t = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const claim = (await http.post(`/api/v1/orders/${orderId}/transfers`).set(s.h).send({ payerName: 'Bola Ade', payerReference: `0000${uniq()}` }).expect(201)).body;
    await http.post(`/api/v1/orders/${orderId}/transfers/${claim.id}/verify`).set(s.h).send({ amountReceivedMinor: t.totalMinor.toString() }).expect(200);
  }
  const zones = async (s: { h: H }) => {
    const lagos = (await http.post('/api/v1/delivery/zones').set(s.h).send({ name: 'Lagos', states: ['Lagos'], feeMinor: '300000', etaDays: 3 }).expect(201)).body;
    const ikejaZone = (await http.post('/api/v1/delivery/zones').set(s.h).send({ name: 'Ikeja & Ogba', states: ['Lagos'], cities: ['Ikeja', 'Ogba'], feeMinor: '150000', etaDays: 1 }).expect(201)).body;
    return { lagos, ikejaZone };
  };

  // ───────────────────────── Logistics ─────────────────────────
  describe('delivery zones and checkout pricing', () => {
    it('zones: delivery:manage only, validated, scoped to the store', async () => {
      const s = await store();
      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.post('/api/v1/delivery/zones').set(assistant).send({ name: 'Lagos', states: ['Lagos'], feeMinor: '300000' }).expect(403);
      await http.post('/api/v1/delivery/zones').set(s.h).send({ name: 'Nowhere', feeMinor: '300000' }).expect(400);
      await http.post('/api/v1/delivery/zones').set(s.h).send({ name: 'Lagos', states: ['Lagos'], feeMinor: '-1' }).expect(400);
      await http.post('/api/v1/delivery/zones').set(s.h).send({ name: 'Lagos', states: ['Lagos'], feeMinor: '1.5' }).expect(400);
      const { lagos } = await zones(s);
      expect(lagos).toMatchObject({ name: 'Lagos', states: ['Lagos'], feeMinor: '300000', etaDays: 3, currency: 'NGN', isActive: true });
      const other = await store();
      await http.patch(`/api/v1/delivery/zones/${lagos.id}`).set(other.h).send({ feeMinor: '1' }).expect(404);
      await http.delete(`/api/v1/delivery/zones/${lagos.id}`).set(other.h).expect(404);
      expect((await http.get('/api/v1/delivery/settings').set(other.h).expect(200)).body.zones).toEqual([]);
      const s2 = (await http.get('/api/v1/delivery/settings').set(assistant).expect(200)).body;
      expect(s2.zones).toHaveLength(2);
      expect(s2.providers).toEqual([{ code: 'manual', name: 'Recorded by the seller', capabilities: { booking: false, quotes: false, tracking: false } }]);
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'delivery.zone_created' } })).toBe(2);
    });

    it('the server prices delivery from the zones (city beats state); the client can’t set the fee', async () => {
      const s = await store();
      await zones(s);
      const q = (await http.get(`/api/v1/store/${s.slug}/delivery-options?state=Lagos&city=Ikeja`).expect(200)).body;
      expect(q.delivery).toMatchObject({ available: true, feeMinor: '150000', zone: { name: 'Ikeja & Ogba', etaDays: 1 }, feeToBeAgreed: false });
      expect(q.pickup).toMatchObject({ available: false });
      const o = await checkout(s);
      expect(o.order).toMatchObject({ subtotalMinor: 2_500_000n, deliveryFeeMinor: 150_000n, totalMinor: 2_650_000n });
      const yaba = await checkout(s, { address: { line1: '1 Herbert Macaulay', city: 'Yaba', state: 'Lagos' } });
      expect(yaba.order.deliveryFeeMinor).toBe(300_000n);
      // Client-supplied fee is not a checkout field.
      await http.post(`/api/v1/store/${s.slug}/checkout`).send({ customer: { fullName: 'Amaka Nnaji', phone: phone() }, items: [{ variantId: s.variantId, quantity: 1 }], shippingAddress: ikeja, deliveryFeeMinor: '0' }).expect(400);
      const d = await prisma.deliveryOrder.findUniqueOrThrow({ where: { orderId: o.id }, include: { zone: true } });
      expect(d).toMatchObject({ method: 'SELLER_DELIVERY', status: 'PENDING', logisticsProvider: 'manual', zone: { name: 'Ikeja & Ogba' } });
      // The customer sees the fee on the tracking page.
      const t = (await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${o.token}`).expect(200)).body;
      expect(t).toMatchObject({ deliveryFeeMinor: '150000', totalMinor: '2650000', delivery: { method: 'SELLER_DELIVERY', status: 'PENDING', zone: { name: 'Ikeja & Ogba' } } });
    });

    it('outside every zone: fee agreed later, or refused when the store says so; pickup only when offered', async () => {
      const s = await store();
      await zones(s);
      const kano = { line1: '1 Zoo Road', city: 'Kano', state: 'Kano' };
      const agreed = await checkout(s, { address: kano });
      expect(agreed.order.deliveryFeeMinor).toBe(0n);
      expect((await checkout(s, { address: null, method: 'PICKUP' })).res.status).toBe(400);
      await http.put('/api/v1/delivery/settings').set(s.h).send({ pickupEnabled: true }).expect(400); // needs an address
      await http.put('/api/v1/delivery/settings').set(s.h).send({ pickupEnabled: true, pickupAddress: 'Shop 12, Computer Village, Ikeja', pickupInstructions: 'Mon–Sat 10–6', deliverOutsideZones: false }).expect(200);
      const refused = await checkout(s, { address: kano });
      expect(refused.res.status).toBe(400);
      expect(refused.res.body.code).toBe('DELIVERY_UNAVAILABLE');
      // Delivery needs an address; pickup doesn't.
      expect((await checkout(s, { address: null })).res.status).toBe(400);
      const p = await checkout(s, { address: null, method: 'PICKUP' });
      expect(p.order).toMatchObject({ deliveryFeeMinor: 0n, totalMinor: 2_500_000n, shippingAddress: null });
      const t = (await http.get(`/api/v1/store/${s.slug}/orders/${p.reference}?token=${p.token}`).expect(200)).body;
      expect(t.delivery).toMatchObject({ method: 'PICKUP', pickupAddress: 'Shop 12, Computer Village, Ikeja', pickupInstructions: 'Mon–Sat 10–6' });
      const opts = (await http.get(`/api/v1/store/${s.slug}/delivery-options`).expect(200)).body;
      expect(opts.pickup).toMatchObject({ available: true, address: 'Shop 12, Computer Village, Ikeja' });
    });
  });

  describe('delivering an order', () => {
    it('third-party courier: details, in transit dispatches the order with the tracking note, failed needs a reason, delivered delivers', async () => {
      const s = await store();
      const o = await checkout(s);
      await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(s.h).send({ status: 'IN_TRANSIT' }).expect(409); // unpaid
      await pay(s, o);
      await http.put(`/api/v1/orders/${o.id}/delivery`).set(s.h).send({ method: 'THIRD_PARTY' }).expect(400); // courier name needed
      const d = (await http.put(`/api/v1/orders/${o.id}/delivery`).set(s.h).send({ method: 'THIRD_PARTY', carrierName: 'GIG Logistics', trackingReference: 'GIG-123456' }).expect(200)).body;
      expect(d.delivery).toMatchObject({ method: 'THIRD_PARTY', carrierName: 'GIG Logistics', trackingReference: 'GIG-123456', status: 'PENDING' });
      expect(d.delivery.nextStatuses).toEqual(['ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'FAILED']);

      const moderator = await member(s.tenantId, 'LIVE_MODERATOR');
      await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(moderator).send({ status: 'IN_TRANSIT' }).expect(403);
      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      const moved = (await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(assistant).send({ status: 'IN_TRANSIT' }).expect(200)).body;
      expect(moved).toMatchObject({ orderStatus: 'DISPATCHED', delivery: { status: 'IN_TRANSIT', dispatchedAt: expect.any(String) } });
      const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
      expect(order).toMatchObject({ status: 'DISPATCHED', fulfilmentStatus: 'DISPATCHED', stockCommittedAt: expect.any(Date) });
      const ev = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: o.id, type: 'ORDER_DISPATCHED' } });
      expect((ev.payload as { note: string }).note).toBe('Sent with GIG Logistics, tracking GIG-123456');

      await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(s.h).send({ status: 'FAILED' }).expect(400);
      await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(s.h).send({ status: 'FAILED', note: 'Customer not reachable' }).expect(200);
      const hist = await prisma.orderStatusHistory.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' } });
      expect(hist.at(-1)).toMatchObject({ fromStatus: 'DISPATCHED', toStatus: 'DISPATCHED', note: 'Delivery attempt failed: Customer not reachable' });
      expect(await prisma.outboxEvent.count({ where: { entityId: o.id } })).toBe(4); // placed, transfer reported, paid, dispatched — not the failure
      await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(s.h).send({ status: 'IN_TRANSIT' }).expect(200); // retry
      const done = (await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(s.h).send({ status: 'DELIVERED' }).expect(200)).body;
      expect(done).toMatchObject({ orderStatus: 'DELIVERED', delivery: { status: 'DELIVERED', nextStatuses: [] } });
      await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(s.h).send({ status: 'RETURNED', note: 'x' }).expect(409);
      const t = (await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${o.token}`).expect(200)).body;
      expect(t.delivery).toMatchObject({ status: 'DELIVERED', carrierName: 'GIG Logistics', trackingReference: 'GIG-123456' });
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'delivery.status_changed', entityId: o.id } })).toBe(4);
      const other = await store();
      await http.get(`/api/v1/orders/${o.id}/delivery`).set(other.h).expect(404);
      await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(other.h).send({ status: 'DELIVERED' }).expect(404);
    });

    it('pickup is collected (no transit); moving the order itself keeps the delivery in step; the board lists both', async () => {
      const s = await store();
      await http.put('/api/v1/delivery/settings').set(s.h).send({ pickupEnabled: true, pickupAddress: 'Shop 12, Ikeja' }).expect(200);
      const p = await checkout(s, { address: null, method: 'PICKUP' });
      await pay(s, p);
      await http.post(`/api/v1/orders/${p.id}/delivery/status`).set(s.h).send({ status: 'IN_TRANSIT' }).expect(409);
      const collected = (await http.post(`/api/v1/orders/${p.id}/delivery/status`).set(s.h).send({ status: 'DELIVERED', note: 'Collected by Amaka' }).expect(200)).body;
      expect(collected).toMatchObject({ orderStatus: 'DELIVERED', delivery: { method: 'PICKUP', status: 'DELIVERED' } });

      // Staff order with an address, moved with the ordinary status endpoint.
      const staff = (await http.post('/api/v1/orders').set(s.h).send({ customer: { fullName: 'Bola Ade', phone: phone() }, items: [{ variantId: s.variantId, quantity: 1 }], shippingAddress: ikeja, deliveryFeeMinor: '200000' }).expect(201)).body;
      await payStaff(s, staff.id);
      const board = (await http.get('/api/v1/deliveries?status=PENDING').set(s.h).expect(200)).body;
      expect(board.items.map((i: { id: string }) => i.id)).toContain(staff.id); // no delivery row yet, still listed
      await http.post(`/api/v1/orders/${staff.id}/status`).set(s.h).send({ status: 'DISPATCHED', note: 'Our rider' }).expect(200);
      expect(await prisma.deliveryOrder.findUniqueOrThrow({ where: { orderId: staff.id } })).toMatchObject({ method: 'SELLER_DELIVERY', status: 'IN_TRANSIT', dispatchedAt: expect.any(Date) });
      await http.post(`/api/v1/orders/${staff.id}/status`).set(s.h).send({ status: 'DELIVERED' }).expect(200);
      expect(await prisma.deliveryOrder.findUniqueOrThrow({ where: { orderId: staff.id } })).toMatchObject({ status: 'DELIVERED', deliveredAt: expect.any(Date) });
      const delivered = (await http.get('/api/v1/deliveries?status=DELIVERED').set(s.h).expect(200)).body;
      expect(delivered.items.map((i: { id: string }) => i.id).sort()).toEqual([p.id, staff.id].sort());
      expect(delivered.items.find((i: { id: string }) => i.id === staff.id)).toMatchObject({ deliveryFeeMinor: '200000', customer: { fullName: 'Bola Ade' } });
    });

    it('a zone used by an order is switched off instead of deleted; an unused one is deleted', async () => {
      const s = await store();
      const { lagos, ikejaZone } = await zones(s);
      await checkout(s);
      expect((await http.delete(`/api/v1/delivery/zones/${ikejaZone.id}`).set(s.h).expect(200)).body).toEqual({ removed: true, archived: true });
      expect((await http.delete(`/api/v1/delivery/zones/${lagos.id}`).set(s.h).expect(200)).body).toEqual({ removed: true, archived: false });
      const z = (await http.get('/api/v1/delivery/settings').set(s.h).expect(200)).body.zones;
      expect(z).toEqual([expect.objectContaining({ id: ikejaZone.id, isActive: false })]);
      expect((await checkout(s)).order.deliveryFeeMinor).toBe(0n); // inactive zone no longer prices
    });
  });

  // ───────────────────────── Analytics ─────────────────────────
  describe('analytics', () => {
    it('is a Professional feature: Starter gets 403 with an upgrade message', async () => {
      const s = await store();
      const r = await http.get('/api/v1/analytics').set(s.h).expect(403);
      expect(r.body).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN', feature: 'analytics' });
      await http.get('/api/v1/analytics/report.pdf').set(s.h).expect(403);
      await http.post('/api/v1/billing/subscription/change').set(s.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200);
      await http.get('/api/v1/analytics').set(s.h).expect(200);
      const moderator = await member(s.tenantId, 'LIVE_MODERATOR');
      await http.get('/api/v1/analytics').set(moderator).expect(403); // reports:read
    });

    it('real figures: sales, rates, channels, sessions with recorded viewers only, top products, customers, previous period', async () => {
      const s = await store();
      await http.post('/api/v1/billing/subscription/change').set(s.h).send({ planCode: 'BUSINESS', interval: 'MONTHLY' }).expect(200);
      const empty = (await http.get('/api/v1/analytics').set(s.h).expect(200)).body;
      expect(empty.overview).toMatchObject({ orders: 0, grossSalesMinor: '0', paymentCompletionBps: null, averageOrderValueMinor: '0' });
      expect(empty.series).toHaveLength(30);

      // Storefront: repeat customer pays twice (1 bag + 2 bags), one unpaid, one cancelled-unpaid.
      const repeat = phone();
      const a = await checkout(s, { phone: repeat });
      await pay(s, a);
      const b = await checkout(s, { phone: repeat, qty: 2 });
      await pay(s, b);
      await checkout(s);
      const c = await checkout(s);
      await http.post(`/api/v1/orders/${c.id}/status`).set(s.h).send({ status: 'CANCELLED', note: 'Customer changed mind' }).expect(200);

      // Two TikTok lives: one with viewers recorded, one without.
      const ch = (await http.post('/api/v1/sales-channels').set(s.h).send({ type: 'TIKTOK_LIVE', name: 'TikTok' }).expect(201)).body;
      const live1 = (await http.post('/api/v1/live-sessions').set(s.h).send({ title: 'Friday bags', channelId: ch.id, scheduledAt: new Date().toISOString() }).expect(201)).body;
      await http.post(`/api/v1/live-sessions/${live1.id}/start`).set(s.h).expect(200);
      const l1 = (await http.post('/api/v1/orders').set(s.h).send({ liveSessionId: live1.id, customer: { fullName: 'Bola Ade', phone: phone() }, items: [{ variantId: s.variantId, quantity: 1 }] }).expect(201)).body;
      const l2 = (await http.post('/api/v1/orders').set(s.h).send({ liveSessionId: live1.id, customer: { fullName: 'Chidi Obi', phone: phone() }, items: [{ variantId: s.variantId, quantity: 1 }] }).expect(201)).body;
      await payStaff(s, l1.id);
      await http.post(`/api/v1/live-sessions/${live1.id}/end`).set(s.h).send({ peakViewers: 40 }).expect(200);
      const live2 = (await http.post('/api/v1/live-sessions').set(s.h).send({ title: 'Saturday', channelId: ch.id, scheduledAt: new Date().toISOString() }).expect(201)).body;
      await http.post(`/api/v1/live-sessions/${live2.id}/start`).set(s.h).expect(200);
      await http.post(`/api/v1/live-sessions/${live2.id}/end`).set(s.h).send({}).expect(200);
      void l2;

      // Refund half of order b (recorded bank-transfer refund).
      await http.post(`/api/v1/orders/${b.id}/refunds`).set(s.h).send({ amountMinor: '1000000', reason: 'One bag returned' }).expect(201);

      // An older paid order lands in the previous period.
      const old = await checkout(s);
      await pay(s, old);
      await prisma.order.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 40 * DAY) } });

      const r = (await http.get('/api/v1/analytics').set(s.h).expect(200)).body;
      // 6 orders in range: a, b, unpaid, c (cancelled), l1, l2 (no zones, so no delivery fees). Paid: a, b, l1.
      expect(r.overview).toMatchObject({
        orders: 6, paidOrders: 3, awaitingPayment: 2, cancelledOrders: 1,
        grossSalesMinor: '10000000', refundsMinor: '1000000', netSalesMinor: '9000000', averageOrderValueMinor: '3333333', unitsSold: 4,
        paymentCompletionBps: 5000, cancellationBps: 1667, liveSessions: 2, liveOrders: 2,
        buyers: 2, repeatBuyers: 1, repeatPurchaseBps: 5000,
      });
      expect(r.overview.newCustomers).toBe(5); // repeat customer, unpaid, cancelled, Bola, Chidi (the old order's customer started 40 days ago)
      expect(r.comparison.paidOrders).toMatchObject({ previous: 1, change: 2, changeBps: 20000 });
      expect(r.comparison.grossSalesMinor).toMatchObject({ previous: '2500000', change: '7500000' });

      const online = r.channels.find((x: { type: string }) => x.type === 'STOREFRONT');
      const tiktok = r.channels.find((x: { channelId: string }) => x.channelId === ch.id);
      expect(online).toMatchObject({ orders: 4, paidOrders: 2, cancelledOrders: 1, grossSalesMinor: '7500000', paymentCompletionBps: 5000 });
      expect(tiktok).toMatchObject({ name: 'TikTok', orders: 2, paidOrders: 1, grossSalesMinor: '2500000', newCustomers: 2 });

      const s1 = r.sessions.find((x: { id: string }) => x.id === live1.id);
      const s2 = r.sessions.find((x: { id: string }) => x.id === live2.id);
      expect(s1).toMatchObject({ title: 'Friday bags', channel: 'TikTok', orders: 2, paidOrders: 1, unitsSold: 1, grossSalesMinor: '2500000', buyers: 1, peakViewers: 40, conversionBps: 250, viewerData: 'seller_reported', paymentCompletionBps: 5000 });
      expect(s2).toMatchObject({ orders: 0, peakViewers: null, conversionBps: null, viewerData: 'not_provided', paymentCompletionBps: null });
      expect(r.topProducts).toEqual([expect.objectContaining({ productCode: 'BAG001', name: 'Leather Bag', unitsSold: 4, orders: 3, revenueMinor: '10000000' })]);
      const today = r.series.at(-1);
      expect(today).toMatchObject({ orders: 6, paidOrders: 3, grossSalesMinor: '10000000' });

      // Channel filter.
      const only = (await http.get(`/api/v1/analytics?channelId=${ch.id}`).set(s.h).expect(200)).body;
      expect(only.overview).toMatchObject({ orders: 2, paidOrders: 1, liveSessions: 2, newCustomers: 2 });
      expect(only.channel).toMatchObject({ id: ch.id, name: 'TikTok' });
      const other = await store2();
      await http.get(`/api/v1/analytics?channelId=${ch.id}`).set(other.h).expect(404);
      expect((await http.get('/api/v1/analytics').set(other.h).expect(200)).body.overview.orders).toBe(0);

      // Ranges.
      await http.get('/api/v1/analytics?from=2026-13-01').set(s.h).expect(400);
      await http.get('/api/v1/analytics?from=2020-01-01&to=2026-01-01').set(s.h).expect(400);
      const old40 = new Date(Date.now() - 40 * DAY + 3_600_000).toISOString().slice(0, 10);
      const prev = (await http.get(`/api/v1/analytics?from=${old40}&to=${old40}`).set(s.h).expect(200)).body;
      expect(prev.overview).toMatchObject({ orders: 1, paidOrders: 1, grossSalesMinor: '2500000' });
      expect(prev.series).toHaveLength(1);

      // CSV and PDF.
      const csv = await http.get('/api/v1/analytics/export?report=summary').set(s.h).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toMatch(/attachment; filename="livesell-summary-/);
      expect(csv.text).toContain('gross_sales,100000.00,25000.00');
      expect(csv.text).toContain('net_sales,90000.00');
      const sessionsCsv = await http.get('/api/v1/analytics/export?report=sessions').set(s.h).expect(200);
      expect(sessionsCsv.text).toContain('Friday bags,TikTok');
      expect(sessionsCsv.text).toContain('seller_reported,2.50');
      await http.get('/api/v1/analytics/export?report=nope').set(s.h).expect(400);
      const pdf = await http.get('/api/v1/analytics/report.pdf').set(s.h).buffer(true).parse(binary as never).expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      expect((pdf.body as Buffer).length).toBeGreaterThan(1500);
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'analytics.exported' } })).toBe(3);
    });
  });

  async function store2() {
    const s = await store();
    await http.post('/api/v1/billing/subscription/change').set(s.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200);
    return s;
  }
});
