import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { configureApp } from '../src/configure-app';
import { OrdersService } from '../src/orders/orders.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer } from './support';

const PASSWORD = 'CorrectHorse42';
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
type H = Record<string, string>;

describe('Phase 4 — orders and live selling', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer).useValue(new CapturingMailer())
      .overrideProvider(BillingNotifier).useValue(new CapturingBillingNotifier())
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p4-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p4-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { slug: body.storeUsername, tenantId: res.body.tenant.id as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } as H };
  }
  async function member(tenantId: string, roleKey: string): Promise<H> {
    const other = await register();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId, key: roleKey } });
    const m = await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    await prisma.tenantMember.create({ data: { tenantId, userId: m.userId, roleId: role.id } });
    return { Authorization: other.h.Authorization, 'X-Tenant-Id': tenantId };
  }
  /** A store with BAG001 (Black ₦25,000 promo ₦22,000 ×5 / Brown ₦25,000 ×1) and CAP002 (₦5,000 ×10). */
  async function store() {
    const s = await register();
    const bag = (await http.post('/api/v1/products').set(s.h).send({
      name: 'Premium Leather Bag', productCode: 'BAG001', status: 'ACTIVE',
      variants: [
        { attributes: { Colour: 'Black' }, sku: 'BAG001-BLK', priceMinor: '2500000', promoPriceMinor: '2200000', initialStock: 5 },
        { attributes: { Colour: 'Brown' }, sku: 'BAG001-BRN', priceMinor: '2500000', initialStock: 1 },
      ],
    }).expect(201)).body;
    const cap = (await http.post('/api/v1/products').set(s.h).send({ name: 'Cap', productCode: 'CAP002', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '500000', initialStock: 10 }] }).expect(201)).body;
    const blk = bag.variants.find((v: any) => v.sku === 'BAG001-BLK').id as string;
    const brn = bag.variants.find((v: any) => v.sku === 'BAG001-BRN').id as string;
    return { ...s, bag, cap, blk, brn, capV: cap.variants[0].id as string };
  }
  const stock = (variantId: string) => prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  const post = (h: H, body: object) => http.post('/api/v1/orders').set(h).send(body);
  const move = (h: H, id: string, status: string, note?: string) => http.post(`/api/v1/orders/${id}/status`).set(h).send({ status, ...(note ? { note } : {}) });

  // ───────────────────────── Orders ─────────────────────────
  describe('order entry', () => {
    it('records an order by product code and by variant, creates the customer, computes totals and reserves stock', async () => {
      const s = await store();
      const p = phone();
      const r = await post(s.h, {
        customer: { fullName: 'Chiamaka Eze', phone: p },
        items: [{ productCode: 'bag001', variantSku: 'BAG001-BLK', quantity: 2, discountMinor: '100000' }, { variantId: s.capV, quantity: 1 }],
        discountMinor: '50000', deliveryFeeMinor: '150000', shippingAddress: { line1: '5 Admiralty Way', city: 'Lekki', state: 'Lagos' },
      }).expect(201);
      const o = r.body;
      expect(o.reference).toMatch(/^LS-[2-9A-HJKMNP-Z]{6}$/);
      expect(o).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', subtotalMinor: '4800000', discountMinor: '50000', deliveryFeeMinor: '150000', totalMinor: '4900000', channel: { type: 'MANUAL' } });
      expect(o.items.map((i: any) => [i.productCode, i.variantName, i.unitPriceMinor, i.quantity, i.lineTotalMinor])).toEqual([['BAG001', 'Black', '2200000', 2, '4300000'], ['CAP002', 'Default', '500000', 1, '500000']]);
      expect(o.shippingAddress).toMatchObject({ line1: '5 Admiralty Way', fullName: 'Chiamaka Eze', phone: p });
      expect(new Date(o.reservationExpiresAt).getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
      expect(o.nextStatuses).toEqual(['CANCELLED']);
      expect(o.statusHistory).toEqual([expect.objectContaining({ fromStatus: null, toStatus: 'PENDING_PAYMENT', actorType: 'user' })]);
      expect(await stock(s.blk)).toMatchObject({ onHand: 5, reserved: 2 });

      const again = (await post(s.h, { customer: { fullName: 'Different Name', phone: p }, items: [{ productCode: 'CAP002', quantity: 1 }] }).expect(201)).body;
      expect(again.customer.id).toBe(o.customer.id);
      expect(again.customer.fullName).toBe('Chiamaka Eze');
    });

    it('asks which variant when a code has several, and rejects unknown or unavailable items', async () => {
      const s = await store();
      const r = await post(s.h, { items: [{ productCode: 'BAG001', quantity: 1 }] }).expect(400);
      expect(r.body).toMatchObject({ code: 'VARIANT_REQUIRED', productCode: 'BAG001', variants: [{ sku: 'BAG001-BLK', name: 'Black' }, { sku: 'BAG001-BRN', name: 'Brown' }] });
      await post(s.h, { items: [{ productCode: 'NOPE99', quantity: 1 }] }).expect(404);
      await post(s.h, { items: [{ productCode: 'BAG001', variantSku: 'BAG001-RED', quantity: 1 }] }).expect(400);
      await post(s.h, { items: [{ quantity: 1 }] }).expect(400);
      await post(s.h, { items: [{ variantId: s.capV, quantity: 1, unitPriceMinor: '1' }] }).expect(400); // prices never come from the client
      await post(s.h, { items: [{ variantId: s.capV, quantity: 1, discountMinor: '500001' }] }).expect(400);
      await post(s.h, { items: [{ variantId: s.capV, quantity: 1 }], discountMinor: '999999999' }).expect(400);
      await http.patch(`/api/v1/products/${s.cap.id}`).set(s.h).send({ status: 'ARCHIVED' }).expect(200);
      await post(s.h, { items: [{ variantId: s.capV, quantity: 1 }] }).expect(409);
      const short = await post(s.h, { items: [{ variantId: s.brn, quantity: 2 }] }).expect(409);
      expect(short.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', shortages: [{ variantId: s.brn, requested: 2, available: 1 }] });
    });

    it('drafts reserve nothing until confirmed; confirmation fails cleanly when stock ran out', async () => {
      const s = await store();
      const d = (await post(s.h, { items: [{ variantId: s.brn, quantity: 1 }], confirm: false }).expect(201)).body;
      expect(d).toMatchObject({ status: 'DRAFT', paymentStatus: 'UNPAID', reservationExpiresAt: null });
      expect((await stock(s.brn)).reserved).toBe(0);
      await post(s.h, { items: [{ variantId: s.brn, quantity: 1 }] }).expect(201); // someone else takes the last one
      const fail = await move(s.h, d.id, 'PENDING_PAYMENT').expect(409);
      expect(fail.body.code).toBe('INSUFFICIENT_STOCK');
      expect((await http.get(`/api/v1/orders/${d.id}`).set(s.h)).body.status).toBe('DRAFT');
      await http.patch(`/api/v1/orders/${d.id}`).set(s.h).send({ items: [{ variantId: s.capV, quantity: 3 }] }).expect(200);
      const ok = (await move(s.h, d.id, 'PENDING_PAYMENT').expect(200)).body;
      expect(ok.status).toBe('PENDING_PAYMENT');
      expect((await stock(s.capV)).reserved).toBe(3);
    });

    it('editing an awaiting-payment order re-reserves stock and records the change', async () => {
      const s = await store();
      const o = (await post(s.h, { items: [{ variantId: s.blk, quantity: 2 }] }).expect(201)).body;
      const e = (await http.patch(`/api/v1/orders/${o.id}`).set(s.h).send({ items: [{ variantId: s.blk, quantity: 4 }, { variantId: s.capV, quantity: 1 }], deliveryFeeMinor: '200000' }).expect(200)).body;
      expect(e).toMatchObject({ subtotalMinor: '9300000', totalMinor: '9500000' });
      expect(await stock(s.blk)).toMatchObject({ reserved: 4 });
      expect(await stock(s.capV)).toMatchObject({ reserved: 1 });
      expect(e.statusHistory.at(-1)).toMatchObject({ toStatus: 'PENDING_PAYMENT', note: 'Edited: items, delivery fee' });
      await http.patch(`/api/v1/orders/${o.id}`).set(s.h).send({ items: [{ variantId: s.blk, quantity: 6 }] }).expect(409); // only 5 on hand
      expect((await stock(s.blk)).reserved).toBe(4); // failed edit rolled back
    });
  });

  describe('order lifecycle', () => {
    it('only a verified payment marks an order paid; fulfilment moves forward and converts reserved stock to a sale once', async () => {
      const s = await store();
      const o = (await post(s.h, { items: [{ variantId: s.blk, quantity: 2 }] }).expect(201)).body;
      await move(s.h, o.id, 'PAID').expect(400); // not a status a person can set
      await move(s.h, o.id, 'PROCESSING').expect(409); // not paid yet

      expect(await orders.markPaid(s.tenantId, o.id, { verifiedBy: 'test:verified-webhook' })).toEqual({ applied: true, status: 'PAID' });
      expect(await orders.markPaid(s.tenantId, o.id, { verifiedBy: 'duplicate' })).toEqual({ applied: false, status: 'PAID' }); // idempotent
      let cur = (await http.get(`/api/v1/orders/${o.id}`).set(s.h).expect(200)).body;
      expect(cur).toMatchObject({ status: 'PAID', paymentStatus: 'PAID', reservationExpiresAt: null, nextStatuses: ['PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'DELIVERED'] });
      const cancel = await move(s.h, o.id, 'CANCELLED').expect(409);
      expect(cancel.body.message).toMatch(/refund/);

      await move(s.h, o.id, 'PROCESSING').expect(200);
      cur = (await move(s.h, o.id, 'DISPATCHED', 'GIG Logistics, waybill 123').expect(200)).body;
      expect(cur).toMatchObject({ status: 'DISPATCHED', fulfilmentStatus: 'DISPATCHED' });
      expect(await stock(s.blk)).toMatchObject({ onHand: 3, reserved: 0 });
      await move(s.h, o.id, 'PROCESSING').expect(409); // no going back
      cur = (await move(s.h, o.id, 'DELIVERED').expect(200)).body;
      expect(await stock(s.blk)).toMatchObject({ onHand: 3, reserved: 0 }); // not committed twice
      expect(cur.statusHistory.map((h: any) => [h.toStatus, h.actorType])).toEqual([
        ['PENDING_PAYMENT', 'user'], ['PAID', 'system'], ['PROCESSING', 'user'], ['DISPATCHED', 'user'], ['DELIVERED', 'user'],
      ]);
      expect(cur.statusHistory[3].note).toBe('GIG Logistics, waybill 123');
      expect(cur.statusHistory[2].actorName).toMatch(/^Owner /);
      const sale = await prisma.inventoryMovement.findFirstOrThrow({ where: { orderId: o.id, type: 'SALE' } });
      expect(sale).toMatchObject({ quantity: -2, onHandAfter: 3, reservedAfter: 0 });
      await expect(prisma.orderStatusHistory.updateMany({ where: { orderId: o.id }, data: { note: 'x' } })).rejects.toThrow(/append-only/);
    });

    it('cancelling an unpaid order releases its stock; roles limit who can cancel and fulfil', async () => {
      const s = await store();
      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      const moderator = await member(s.tenantId, 'LIVE_MODERATOR');
      const o = (await post(assistant, { items: [{ variantId: s.blk, quantity: 3 }] }).expect(201)).body; // assistants create orders
      await move(assistant, o.id, 'CANCELLED').expect(403);
      await move(s.h, o.id, 'CANCELLED', 'Customer changed mind').expect(200);
      expect(await stock(s.blk)).toMatchObject({ reserved: 0 });
      await move(s.h, o.id, 'PENDING_PAYMENT').expect(409); // cancelled is final

      const p = (await post(moderator, { items: [{ variantId: s.capV, quantity: 1 }] }).expect(201)).body;
      await orders.markPaid(s.tenantId, p.id, { verifiedBy: 'test' });
      await move(moderator, p.id, 'PROCESSING').expect(403); // moderators record orders but don't fulfil
      await move(assistant, p.id, 'PROCESSING').expect(200);
      await http.patch(`/api/v1/orders/${p.id}`).set(s.h).send({ deliveryFeeMinor: '1' }).expect(409); // paid orders are not editable
    });

    it('§26 #2: unpaid orders are cancelled when the hold expires and their stock comes back; holds can be extended', async () => {
      const s = await store();
      const o = (await post(s.h, { items: [{ variantId: s.brn, quantity: 1 }] }).expect(201)).body;
      const keep = (await post(s.h, { items: [{ variantId: s.capV, quantity: 2 }] }).expect(201)).body;
      const ext = (await http.post(`/api/v1/orders/${keep.id}/extend-hold`).set(s.h).send({ hours: 24 }).expect(200)).body;
      expect(new Date(ext.reservationExpiresAt).getTime()).toBeGreaterThan(new Date(keep.reservationExpiresAt).getTime());
      await prisma.order.update({ where: { id: o.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });

      expect(await orders.expireReservations(new Date())).toBeGreaterThanOrEqual(1);
      const gone = (await http.get(`/api/v1/orders/${o.id}`).set(s.h)).body;
      expect(gone).toMatchObject({ status: 'CANCELLED', paymentStatus: 'UNPAID', reservationExpiresAt: null });
      expect(gone.statusHistory.at(-1)).toMatchObject({ actorType: 'system', note: expect.stringMatching(/hold expired/) });
      expect(await stock(s.brn)).toMatchObject({ onHand: 1, reserved: 0 });
      expect((await http.get(`/api/v1/orders/${keep.id}`).set(s.h)).body.status).toBe('PENDING_PAYMENT');
      expect(await prisma.order.count({ where: { id: o.id, status: 'CANCELLED' } })).toBe(1);
      await expect(orders.markPaid(s.tenantId, o.id, { verifiedBy: 'late' })).rejects.toThrow(); // a late payment can't revive it silently
      await http.post(`/api/v1/orders/${o.id}/extend-hold`).set(s.h).send({ hours: 1 }).expect(409);
    });

    it('enforces the plan’s monthly order limit (drafts are free)', async () => {
      const s = await store();
      const tiny = await prisma.subscriptionPlan.create({
        data: { code: `TINY_${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, 30), name: 'Tiny', monthlyPriceMinor: 100n, annualPriceMinor: null, limits: { products: 10, ordersPerMonth: 1, staff: 1, paymentGateways: 1 }, features: {}, isPublic: false },
      });
      await prisma.subscription.updateMany({ where: { tenantId: s.tenantId }, data: { planId: tiny.id } });
      await post(s.h, { items: [{ variantId: s.capV, quantity: 1 }] }).expect(201);
      expect((await post(s.h, { items: [{ variantId: s.capV, quantity: 1 }] }).expect(403)).body.code).toBe('PLAN_LIMIT_REACHED');
      const d = (await post(s.h, { items: [{ variantId: s.capV, quantity: 1 }], confirm: false }).expect(201)).body;
      expect((await move(s.h, d.id, 'PENDING_PAYMENT').expect(403)).body.code).toBe('PLAN_LIMIT_REACHED');
    });

    it('order totals must add up at the database level', async () => {
      const s = await store();
      await expect(prisma.forTenant(s.tenantId).order.create({ data: { reference: `LS-${uniq()}`, subtotalMinor: 100n, discountMinor: 0n, deliveryFeeMinor: 0n, totalMinor: 999n } as any })).rejects.toThrow();
    });
  });

  describe('order lists, export and isolation', () => {
    it('searches by reference, customer, phone and product code; views; export needs customers:export and is audited', async () => {
      const s = await store();
      const p = phone();
      const a = (await post(s.h, { customer: { fullName: 'Ngozi Okafor', phone: p }, items: [{ productCode: 'CAP002', quantity: 1 }] }).expect(201)).body;
      const b = (await post(s.h, { items: [{ variantId: s.blk, quantity: 1 }] }).expect(201)).body;
      await orders.markPaid(s.tenantId, b.id, { verifiedBy: 'test' });
      const q = async (qs: string) => (await http.get(`/api/v1/orders?${qs}`).set(s.h).expect(200)).body;
      expect((await q(`search=${a.reference.slice(3)}`)).items.map((o: any) => o.id)).toEqual([a.id]);
      expect((await q('search=ngozi')).items.map((o: any) => o.id)).toEqual([a.id]);
      expect((await q(`search=${p.slice(-6)}`)).items.map((o: any) => o.id)).toEqual([a.id]);
      expect((await q('search=bag001')).items.map((o: any) => o.id)).toEqual([b.id]);
      expect((await q('view=awaiting_payment')).items.map((o: any) => o.id)).toEqual([a.id]);
      expect((await q('view=to_fulfil')).items.map((o: any) => o.id)).toEqual([b.id]);
      expect((await q('sort=total_desc')).items[0].id).toBe(b.id);
      await http.get('/api/v1/orders?view=everything').set(s.h).expect(400);

      const manager = await member(s.tenantId, 'STORE_MANAGER');
      await http.get('/api/v1/orders').set(manager).expect(200);
      await http.get('/api/v1/orders/export').set(manager).expect(403);
      const csv = (await http.get('/api/v1/orders/export').set(s.h).expect(200)).text;
      expect(csv).toContain(a.reference);
      expect(csv).toContain('Ngozi Okafor');
      expect(csv).toContain('CAP002 x1');
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'orders.exported' } })).toBe(1);
    });

    it('§26 #9: another seller cannot read, change or reference this seller’s orders, products, customers, channels or sessions', async () => {
      const a = await store();
      const b = await store();
      const o = (await post(a.h, { customer: { fullName: 'A Customer', phone: phone() }, items: [{ variantId: a.capV, quantity: 1 }] }).expect(201)).body;
      await http.get(`/api/v1/orders/${o.id}`).set(b.h).expect(404);
      await http.patch(`/api/v1/orders/${o.id}`).set(b.h).send({ notes: 'x' }).expect(404);
      await move(b.h, o.id, 'CANCELLED').expect(404);
      await http.post(`/api/v1/orders/${o.id}/extend-hold`).set(b.h).send({ hours: 1 }).expect(404);
      await post(b.h, { items: [{ variantId: a.capV, quantity: 1 }] }).expect(404);
      await post(b.h, { customer: { customerId: o.customer.id }, items: [{ variantId: b.capV, quantity: 1 }] }).expect(404);
      await post(b.h, { channelId: o.channel.id, items: [{ variantId: b.capV, quantity: 1 }] }).expect(404);
      const ch = (await http.post('/api/v1/sales-channels').set(a.h).send({ type: 'TIKTOK_LIVE', name: 'TikTok' }).expect(201)).body;
      const sess = (await http.post('/api/v1/live-sessions').set(a.h).send({ title: 'A live', channelId: ch.id, scheduledAt: new Date().toISOString() }).expect(201)).body;
      await post(b.h, { liveSessionId: sess.id, items: [{ variantId: b.capV, quantity: 1 }] }).expect(404);
      await http.get(`/api/v1/live-sessions/${sess.id}`).set(b.h).expect(404);
      await http.post(`/api/v1/live-sessions/${sess.id}/start`).set(b.h).expect(404);
      expect((await http.get('/api/v1/orders').set(b.h)).body.total).toBe(0);
      expect(await stock(a.capV)).toMatchObject({ reserved: 1 });
    });
  });

  // ───────────────────────── Live sessions ─────────────────────────
  describe('live sessions', () => {
    it('schedules a session with live prices and moderators, takes orders during it, and reports real numbers', async () => {
      const s = await store();
      const modH = await member(s.tenantId, 'LIVE_MODERATOR');
      const mod = (await http.get('/api/v1/workspace/members').set(s.h)).body.find((m: any) => m.role.key === 'LIVE_MODERATOR');
      const ch = (await http.post('/api/v1/sales-channels').set(s.h).send({ type: 'TIKTOK_LIVE', name: 'TikTok', handle: '@shop' }).expect(201)).body;
      const sess = (await http.post('/api/v1/live-sessions').set(s.h).send({
        title: 'Friday Bag Drop', channelId: ch.id, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        orderInstructions: 'Comment the code and send it to our WhatsApp', products: [{ productId: s.bag.id, sessionPriceMinor: '2000000' }, { productId: s.cap.id }], moderatorIds: [mod.id],
      }).expect(201)).body;
      expect(sess).toMatchObject({ status: 'SCHEDULED', channel: { name: 'TikTok' }, moderators: [{ memberId: mod.id }] });
      expect(sess.products.map((p: any) => [p.product.productCode, p.sessionPriceMinor])).toEqual([['BAG001', '2000000'], ['CAP002', null]]);
      expect(sess.products[0].product.variants.find((v: any) => v.sku === 'BAG001-BLK').available).toBe(5);

      await post(s.h, { liveSessionId: sess.id, items: [{ productCode: 'CAP002', quantity: 1 }] }).expect(409); // not started
      await http.post(`/api/v1/live-sessions/${sess.id}/start`).set(modH).expect(200);
      const o1 = (await post(modH, { liveSessionId: sess.id, customer: { fullName: 'Viewer One', phone: phone() }, items: [{ productCode: 'BAG001', variantSku: 'BAG001-BLK', quantity: 2 }] }).expect(201)).body;
      expect(o1).toMatchObject({ channel: { id: ch.id }, liveSession: { id: sess.id }, totalMinor: '4000000' }); // live price ₦20,000, not ₦22,000
      const o2 = (await post(modH, { liveSessionId: sess.id, customer: { fullName: 'Viewer Two', phone: phone() }, items: [{ productCode: 'CAP002', quantity: 3 }] }).expect(201)).body;
      const o3 = (await post(modH, { liveSessionId: sess.id, customer: { fullName: 'Viewer Three', phone: phone() }, items: [{ productCode: 'CAP002', quantity: 1 }] }).expect(201)).body;
      await orders.markPaid(s.tenantId, o1.id, { verifiedBy: 'test' });
      await orders.markPaid(s.tenantId, o2.id, { verifiedBy: 'test' });
      await move(s.h, o3.id, 'CANCELLED').expect(200);
      await post(s.h, { liveSessionId: sess.id, items: [{ productCode: 'CAP002', quantity: 1 }], confirm: false }).expect(201); // drafts don't count

      const ended = (await http.post(`/api/v1/live-sessions/${sess.id}/end`).set(s.h).send({ peakViewers: 412 }).expect(200)).body;
      expect(ended).toMatchObject({ status: 'ENDED', peakViewers: 412 });
      const rep = (await http.get(`/api/v1/live-sessions/${sess.id}/report`).set(s.h).expect(200)).body;
      expect(rep).toMatchObject({
        orders: { total: 3, paid: 2, awaitingPayment: 0, cancelled: 1 }, revenueMinor: '5500000', unitsSold: 5, averageOrderValueMinor: '2750000',
        uniqueCustomers: 3, paymentCompletionBps: 6667, cancellationBps: 3333, viewerData: 'seller_reported',
      });
      expect(rep.topProducts.map((p: any) => [p.productCode, p.quantity, p.revenueMinor])).toEqual([['CAP002', 3, '1500000'], ['BAG001', 2, '4000000']]);
      expect(JSON.stringify(rep)).not.toMatch(/conversion/i);
      const list = (await http.get('/api/v1/live-sessions?when=past').set(s.h).expect(200)).body;
      expect(list.items[0]).toMatchObject({ id: sess.id, paidOrders: 2, revenueMinor: '5500000' });
      // Late orders can still be recorded against an ended session; ended sessions can't be edited or cancelled.
      await post(s.h, { liveSessionId: sess.id, items: [{ productCode: 'CAP002', quantity: 1 }] }).expect(201);
      await http.patch(`/api/v1/live-sessions/${sess.id}`).set(s.h).send({ title: 'Renamed' }).expect(409);
      await http.post(`/api/v1/live-sessions/${sess.id}/cancel`).set(s.h).expect(409);
      expect((await http.get(`/api/v1/orders?liveSessionId=${sess.id}`).set(s.h)).body.total).toBe(5);
    });

    it('validates session links and roles; viewer counts are optional and never invented', async () => {
      const s = await store();
      const other = await store();
      const ch = (await http.post('/api/v1/sales-channels').set(s.h).send({ type: 'INSTAGRAM_LIVE', name: 'Instagram' }).expect(201)).body;
      const otherCh = (await http.post('/api/v1/sales-channels').set(other.h).send({ type: 'TIKTOK_LIVE', name: 'TikTok' }).expect(201)).body;
      const at = new Date().toISOString();
      await http.post('/api/v1/live-sessions').set(s.h).send({ title: 'Test live', channelId: otherCh.id, scheduledAt: at }).expect(404);
      await http.post('/api/v1/live-sessions').set(s.h).send({ title: 'Test live', channelId: ch.id, scheduledAt: at, products: [{ productId: other.cap.id }] }).expect(404);
      await http.post('/api/v1/live-sessions').set(s.h).send({ title: 'Test live', channelId: ch.id, scheduledAt: at, moderatorIds: [randomUUID()] }).expect(404);
      await http.post('/api/v1/live-sessions').set(s.h).send({ title: 'Test live', channelId: ch.id, scheduledAt: at, products: [{ productId: s.cap.id }, { productId: s.cap.id }] }).expect(400);
      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.post('/api/v1/live-sessions').set(assistant).send({ title: 'Test live', channelId: ch.id, scheduledAt: at }).expect(403);
      const sess = (await http.post('/api/v1/live-sessions').set(s.h).send({ title: 'Quiet live', channelId: ch.id, scheduledAt: at }).expect(201)).body;
      await http.get(`/api/v1/live-sessions/${sess.id}`).set(assistant).expect(200);
      await http.post(`/api/v1/live-sessions/${sess.id}/end`).set(s.h).send({}).expect(409); // not live yet
      await http.post(`/api/v1/live-sessions/${sess.id}/start`).set(s.h).expect(200);
      await http.post(`/api/v1/live-sessions/${sess.id}/start`).set(s.h).expect(409);
      await http.post(`/api/v1/live-sessions/${sess.id}/end`).set(s.h).send({ peakViewers: -5 }).expect(400);
      await http.post(`/api/v1/live-sessions/${sess.id}/end`).set(s.h).send({}).expect(200);
      const rep = (await http.get(`/api/v1/live-sessions/${sess.id}/report`).set(s.h)).body;
      expect(rep).toMatchObject({ viewerData: 'not_provided', paymentCompletionBps: null, orders: { total: 0 }, session: { peakViewers: null } });
      const sched = (await http.post('/api/v1/live-sessions').set(s.h).send({ title: 'Later', channelId: ch.id, scheduledAt: at }).expect(201)).body;
      expect((await http.post(`/api/v1/live-sessions/${sched.id}/cancel`).set(s.h).expect(200)).body.status).toBe('CANCELLED');
      await http.patch(`/api/v1/sales-channels/${ch.id}`).set(s.h).send({ isActive: false }).expect(200);
      await http.post('/api/v1/live-sessions').set(s.h).send({ title: 'Off', channelId: ch.id, scheduledAt: at }).expect(400);
    });
  });

  // ───────────────────────── Storefront checkout ─────────────────────────
  describe('storefront checkout and tracking', () => {
    async function published() {
      const s = await store();
      await http.patch('/api/v1/store/profile').set(s.h).send({ description: 'Bags and caps', whatsappNumber: '+2348031234567' }).expect(200);
      await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
      return s;
    }
    const checkout = (slug: string, body: object) => http.post(`/api/v1/store/${slug}/checkout`).send(body);
    const body = (items: object[], ph = phone()) => ({
      customer: { fullName: 'Amaka Nnaji', phone: ph }, items, shippingAddress: { line1: '3 Bode Thomas', city: 'Surulere', state: 'Lagos' },
    });

    it('places an order at database prices, reserves stock and gives the customer a private tracking link', async () => {
      const s = await published();
      const r = await checkout(s.slug, { ...body([{ variantId: s.blk, quantity: 2 }, { variantId: s.capV, quantity: 1 }]), notes: 'Call before delivery' }).expect(201);
      expect(r.body.reference).toMatch(/^LS-/);
      expect(r.body.trackingToken.length).toBeGreaterThan(20);
      expect(r.body.order).toMatchObject({ status: 'PENDING_PAYMENT', totalMinor: '4900000', store: { whatsappNumber: '+2348031234567' } });
      expect(r.body.order.items.map((i: any) => [i.productCode, i.quantity])).toEqual([['BAG001', 2], ['CAP002', 1]]);
      const staff = (await http.get(`/api/v1/orders?search=${r.body.reference.slice(3)}`).set(s.h)).body.items[0];
      expect(staff).toMatchObject({ status: 'PENDING_PAYMENT', channel: { type: 'STOREFRONT' }, customer: { fullName: 'Amaka Nnaji' } });
      expect(await stock(s.blk)).toMatchObject({ reserved: 2 });
      const db = await prisma.order.findFirstOrThrow({ where: { reference: r.body.reference } });
      expect(db.trackingTokenHash).not.toBe(r.body.trackingToken); // only a hash is stored
      expect(db.reservationExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);

      const t = (await http.get(`/api/v1/store/${s.slug}/orders/${r.body.reference}?token=${r.body.trackingToken}`).expect(200)).body;
      expect(t).toMatchObject({ reference: r.body.reference, status: 'PENDING_PAYMENT', timeline: [{ status: 'PENDING_PAYMENT' }] });
      await http.get(`/api/v1/store/${s.slug}/orders/${r.body.reference}?token=wrong-token-value`).expect(404);
      await http.get(`/api/v1/store/${s.slug}/orders/${r.body.reference}`).expect(404);
      const other = await published();
      await http.get(`/api/v1/store/${other.slug}/orders/${r.body.reference}?token=${r.body.trackingToken}`).expect(404);
      await orders.markPaid(s.tenantId, db.id, { verifiedBy: 'test' });
      expect((await http.get(`/api/v1/store/${s.slug}/orders/${r.body.reference}?token=${r.body.trackingToken}`)).body.timeline.map((x: any) => x.status)).toEqual(['PENDING_PAYMENT', 'PAID']);
      expect(JSON.stringify(t)).not.toMatch(/tenantId|trackingTokenHash|costPrice/);
    });

    it('rejects client prices, unavailable items, short stock, bots and unpublished stores; reuses customers without renaming them', async () => {
      const s = await published();
      await checkout(s.slug, body([{ variantId: s.capV, quantity: 1, priceMinor: '1' }])).expect(400);
      await checkout(s.slug, body([{ variantId: s.capV, quantity: 21 }])).expect(400);
      await checkout(s.slug, { ...body([{ variantId: s.capV, quantity: 1 }]), website: 'http://spam' }).expect(400);
      const short = await checkout(s.slug, body([{ variantId: s.brn, quantity: 2 }])).expect(409);
      expect(short.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', items: [{ variantId: s.brn, name: 'Premium Leather Bag (Brown)', available: 1 }] });
      const draft = (await http.post('/api/v1/products').set(s.h).send({ name: 'Secret', status: 'DRAFT', variants: [{ attributes: {}, priceMinor: '100', initialStock: 5 }] }).expect(201)).body;
      await checkout(s.slug, body([{ variantId: draft.variants[0].id, quantity: 1 }])).expect(409);
      const other = await store();
      await checkout(s.slug, body([{ variantId: other.capV, quantity: 1 }])).expect(404);

      const ph = phone();
      await http.post('/api/v1/customers').set(s.h).send({ fullName: 'Original Name', phone: ph }).expect(201);
      await checkout(s.slug, { ...body([{ variantId: s.capV, quantity: 1 }], ph), customer: { fullName: 'Someone Else', phone: ph } }).expect(201);
      const customers = (await http.get(`/api/v1/customers?search=${ph.slice(-6)}`).set(s.h)).body.items;
      expect(customers).toHaveLength(1);
      expect(customers[0]).toMatchObject({ fullName: 'Original Name', outstanding: 1 });

      await http.post('/api/v1/storefront/unpublish').set(s.h).expect(200);
      await checkout(s.slug, body([{ variantId: s.capV, quantity: 1 }])).expect(404);
    });

    it('§26 #7 at checkout: two customers buy the last bag at the same moment — one order, one clear "sold out"', async () => {
      const s = await published();
      const results = await Promise.all([1, 2].map(() => checkout(s.slug, body([{ variantId: s.brn, quantity: 1 }]))));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await stock(s.brn)).toMatchObject({ onHand: 1, reserved: 1 });
      expect(await prisma.order.count({ where: { tenantId: s.tenantId } })).toBe(1);
    });
  });
});
