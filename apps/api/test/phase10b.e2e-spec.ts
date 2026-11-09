import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ReportSchedulesService } from '../src/analytics/report-schedules.service';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { CommissionBillingService, lagosMonthStart } from '../src/billing/commission-billing.service';
import { configureApp } from '../src/configure-app';
import { MessagingProvider } from '../src/messaging/messaging-provider';
import { PaymentProviderRegistry } from '../src/payments/payment-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer, FakeMessaging, FakePaymentProvider, FakeRegistry } from './support';

const PASSWORD = 'CorrectHorse42';
const DAY = 86_400_000;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
type H = Record<string, string>;
const nextMonth = () => new Date(lagosMonthStart(new Date()).getTime() + 40 * DAY);

describe('Phase 10b — commission plan, advanced analytics, private couriers', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let billing: CommissionBillingService;
  let schedules: ReportSchedulesService;
  let http: ReturnType<typeof request>;
  const paystack = new FakePaymentProvider('PAYSTACK');
  const notifier = new CapturingBillingNotifier();
  const messaging = new FakeMessaging();
  let paystackWasEnabled = false;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer).useValue(new CapturingMailer())
      .overrideProvider(BillingNotifier).useValue(notifier)
      .overrideProvider(MessagingProvider).useValue(messaging)
      .overrideProvider(PaymentProviderRegistry).useValue(new FakeRegistry(paystack))
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    billing = app.get(CommissionBillingService);
    schedules = app.get(ReportSchedulesService);
    http = request(app.getHttpServer());
    paystackWasEnabled = (await prisma.paymentProvider.findUniqueOrThrow({ where: { code: 'PAYSTACK' } })).isEnabled;
    await prisma.paymentProvider.update({ where: { code: 'PAYSTACK' }, data: { isEnabled: true } }); // LiveSell's own invoices are paid via Paystack
  });
  afterAll(async () => {
    await prisma.paymentProvider.update({ where: { code: 'PAYSTACK' }, data: { isEnabled: paystackWasEnabled } });
    await app.close();
  });

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p10b-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p10b-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { email: body.email, slug: body.storeUsername, tenantId: res.body.tenant.id as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } as H };
  }
  async function member(tenantId: string, roleKey: string) {
    const other = await register();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId, key: roleKey } });
    const m = await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    await prisma.tenantMember.create({ data: { tenantId, userId: m.userId, roleId: role.id } });
    return { h: { Authorization: other.h.Authorization, 'X-Tenant-Id': tenantId } as H, userId: m.userId };
  }
  async function store(plan?: string, active = false) {
    const s = await register();
    if (plan === 'ENTERPRISE') {
      // Custom-priced: assigned by LiveSell, not chosen in the app.
      const ent = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'ENTERPRISE' } });
      await prisma.subscription.updateMany({ where: { tenantId: s.tenantId }, data: { planId: ent.id } });
    } else if (plan) await http.post('/api/v1/billing/subscription/change').set(s.h).send({ planCode: plan, interval: 'MONTHLY' }).expect(200);
    // Past the free trial (no commission during a trial).
    if (active) await prisma.subscription.updateMany({ where: { tenantId: s.tenantId }, data: { status: 'ACTIVE', trialEndsAt: null, currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 29 * DAY) } });
    const bag = (await http.post('/api/v1/products').set(s.h).send({ name: 'Leather Bag', productCode: 'BAG001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '2500000', initialStock: 50 }] }).expect(201)).body;
    await http.patch('/api/v1/store/profile').set(s.h).send({ description: 'Bags', whatsappNumber: '+2348031234567' }).expect(200);
    await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
    await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankName: 'Guaranty Trust Bank', accountNumber: '0123456789', accountName: 'ADA FASHION LTD' }).expect(201);
    return { ...s, variantId: bag.variants[0].id as string };
  }
  async function sale(s: { slug: string; h: H; variantId: string }, qty = 1, address: object = { line1: '3 Allen Avenue', city: 'Ikeja', state: 'Lagos' }) {
    const r = (await http.post(`/api/v1/store/${s.slug}/checkout`).send({ customer: { fullName: 'Amaka Nnaji', phone: phone() }, items: [{ variantId: s.variantId, quantity: qty }], shippingAddress: address }).expect(201)).body;
    const o = await prisma.order.findFirstOrThrow({ where: { reference: r.reference } });
    const claim = (await http.post(`/api/v1/store/${s.slug}/orders/${r.reference}/transfer`).send({ token: r.trackingToken, payerName: 'Amaka', payerBank: 'Access', payerReference: `0000${uniq()}` }).expect(200)).body;
    await http.post(`/api/v1/orders/${o.id}/transfers/${claim.id}/verify`).set(s.h).send({ amountReceivedMinor: o.totalMinor.toString() }).expect(200);
    return { id: o.id, reference: r.reference as string, token: r.trackingToken as string };
  }
  const balance = async (tenantId: string | null, code: string) => {
    const rows = await prisma.ledgerEntry.findMany({ where: { account: { tenantId, code } } });
    return rows.reduce((t, r) => t + (r.direction === 'DEBIT' ? r.amountMinor : -r.amountMinor), 0n);
  };

  // ───────────────────────── Pay as you sell ─────────────────────────
  describe('Pay as you sell: everything unlocked, commission on every sale', () => {
    it('the commission plan has no fee, no limits and the advanced features', async () => {
      const plans = (await http.get('/api/v1/plans').expect(200)).body as Array<{ code: string; limits: Record<string, unknown>; features: Record<string, unknown>; monthlyPriceMinor: string; pricingModel: string; commissionBps: number }>;
      const p = plans.find((x) => x.code === 'PAY_AS_YOU_SELL')!;
      expect(p).toMatchObject({ monthlyPriceMinor: '0', pricingModel: 'COMMISSION', commissionBps: 300, limits: { products: null, ordersPerMonth: null, staff: null, paymentGateways: null } });
      expect(p.features).toMatchObject({ analytics: 'advanced', whatsappNotifications: true, orderManagement: 'advanced', automation: true });
      const s = await store('PAY_AS_YOU_SELL');
      const r = (await http.get('/api/v1/analytics').set(s.h).expect(200)).body;
      expect(r.tier).toBe('advanced');
    });

    it('commission on directly collected sales is invoiced monthly, paid through LiveSell, and clears the seller’s debt', async () => {
      const s = await store('PAY_AS_YOU_SELL', true);
      const o1 = await sale(s, 2); // ₦50,000 → 3% = ₦1,500
      await sale(s, 1); // ₦25,000 → ₦750
      expect(await balance(s.tenantId, 'COMMISSION_PAYABLE')).toBe(-225_000n);
      const sum = (await http.get('/api/v1/billing/commission').set(s.h).expect(200)).body;
      expect(sum).toMatchObject({ rate: { bps: 300, pricingModel: 'COMMISSION' }, thisMonthMinor: '225000', unbilledMinor: '225000', writesBlocked: false, invoices: [] });

      // A partial refund before invoicing reverses its share of the commission.
      await http.post(`/api/v1/orders/${o1.id}/refunds`).set(s.h).send({ amountMinor: '1000000', reason: 'One strap missing' }).expect(201); // 20% of ₦50,000 → −₦300
      expect(await balance(s.tenantId, 'COMMISSION_PAYABLE')).toBe(-195_000n);

      // The monthly job, run next month: one invoice, idempotent.
      const inv = await billing.issueFor(s.tenantId, nextMonth());
      expect(inv).toMatchObject({ kind: 'COMMISSION', status: 'OPEN', amountMinor: 195_000n, currency: 'NGN' });
      expect(inv!.dueAt.getTime() - nextMonth().getTime()).toBeGreaterThan(6 * DAY);
      expect(await billing.issueFor(s.tenantId, nextMonth())).toBeNull();
      expect(notifier.commissionInvoices.find((m) => m.invoiceNumber === inv!.number)).toMatchObject({ to: s.email, amountMinor: 195_000n });
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'billing.commission_invoiced' } })).toBe(1);

      // A plan change never voids it.
      await http.post('/api/v1/billing/subscription/change').set(s.h).send({ planCode: 'STARTER', interval: 'MONTHLY' }).expect(200);
      expect((await prisma.subscriptionInvoice.findUniqueOrThrow({ where: { id: inv!.id } })).status).toBe('OPEN');

      // Paid through the platform account; verified server-side; ledger clears payable and receivable.
      const platformReceivableBefore = await balance(null, 'COMMISSION_RECEIVABLE');
      const link = (await http.post(`/api/v1/billing/invoices/${inv!.id}/pay`).set(s.h).expect(200)).body;
      paystack.succeed(link.reference, 195_000n, { feeMinor: 2_925n });
      await http.post('/api/v1/payments/verify').send({ reference: link.reference }).expect(200);
      expect(await prisma.subscriptionInvoice.findUniqueOrThrow({ where: { id: inv!.id } })).toMatchObject({ status: 'PAID' });
      expect(await balance(s.tenantId, 'COMMISSION_PAYABLE')).toBe(0n);
      expect((await balance(null, 'COMMISSION_RECEIVABLE')) - platformReceivableBefore).toBe(-195_000n);
      // The plan wasn't touched by paying a commission invoice.
      const sub = await prisma.subscription.findFirstOrThrow({ where: { tenantId: s.tenantId }, include: { pendingPlan: true, plan: true } });
      expect(sub.plan.code).toBe('PAY_AS_YOU_SELL');
      // Nothing more to bill.
      const after = (await http.get('/api/v1/billing/commission').set(s.h).expect(200)).body;
      expect(after.unbilledMinor).toBe('0');
    });

    it('small amounts carry over; an overdue commission invoice blocks writes until it is paid', async () => {
      const s = await store('PAY_AS_YOU_SELL', true);
      await sale(s, 1); // ₦750 < ₦1,000 minimum
      expect(await billing.issueFor(s.tenantId, nextMonth())).toBeNull();
      await sale(s, 1); // now ₦1,500
      const inv = (await billing.issueFor(s.tenantId, nextMonth()))!;
      expect(inv.amountMinor).toBe(150_000n);

      await prisma.subscriptionInvoice.update({ where: { id: inv.id }, data: { dueAt: new Date(Date.now() - 10 * DAY) } });
      const blocked = await http.post('/api/v1/products').set(s.h).send({ name: 'Cap', productCode: 'CAP001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '500000', initialStock: 1 }] }).expect(402);
      expect(blocked.body.code).toBe('COMMISSION_OVERDUE');
      await http.get('/api/v1/products').set(s.h).expect(200); // reads keep working
      const sum = (await http.get('/api/v1/billing/commission').set(s.h).expect(200)).body;
      expect(sum.writesBlocked).toBe(true);
      expect(sum.invoices[0]).toMatchObject({ id: inv.id, overdue: true });

      const link = (await http.post(`/api/v1/billing/invoices/${inv.id}/pay`).set(s.h).expect(200)).body; // billing recovery stays open
      paystack.succeed(link.reference, 150_000n);
      await http.post('/api/v1/payments/verify').send({ reference: link.reference }).expect(200);
      await http.post('/api/v1/products').set(s.h).send({ name: 'Cap', productCode: 'CAP001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '500000', initialStock: 1 }] }).expect(201);
    });

    it('no commission during the free trial; another store never sees the invoice', async () => {
      const s = await store('PAY_AS_YOU_SELL'); // still trialing
      await sale(s, 2);
      expect(await balance(s.tenantId, 'COMMISSION_PAYABLE')).toBe(0n);
      expect(await billing.issueFor(s.tenantId, nextMonth())).toBeNull();
      const paying = await store('PAY_AS_YOU_SELL', true);
      await sale(paying, 2);
      const inv = (await billing.issueFor(paying.tenantId, nextMonth()))!;
      await http.post(`/api/v1/billing/invoices/${inv.id}/pay`).set(s.h).expect(404);
      expect((await http.get('/api/v1/billing/commission').set(s.h).expect(200)).body.invoices).toEqual([]);
    });
  });

  // ───────────────────────── Analytics tiers ─────────────────────────
  describe('analytics tiers', () => {
    it('Professional (standard): 92-day ranges, CSV; PDF, patterns, top customers and email reports are Business+', async () => {
      const s = await store('PROFESSIONAL');
      const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
      const from120 = new Date(Date.now() + 3_600_000 - 119 * DAY).toISOString().slice(0, 10);
      const r = (await http.get('/api/v1/analytics').set(s.h).expect(200)).body;
      expect(r).toMatchObject({ tier: 'standard', patterns: null, topCustomers: null, limits: { maxDays: 92, pdf: false, schedules: false } });
      const long = await http.get(`/api/v1/analytics?from=${from120}&to=${today}`).set(s.h).expect(403);
      expect(long.body).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN', feature: 'analytics.long_range', maxDays: 92 });
      expect((await http.get('/api/v1/analytics/report.pdf').set(s.h).expect(403)).body.feature).toBe('analytics.pdf');
      expect((await http.get('/api/v1/analytics/export?report=customers').set(s.h).expect(403)).body.feature).toBe('analytics.customers');
      await http.get('/api/v1/analytics/export?report=channels').set(s.h).expect(200);
      expect((await http.get('/api/v1/analytics/schedules').set(s.h).expect(200)).body.available).toBe(false);
      const ownerId = (await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: s.tenantId } })).userId;
      expect((await http.put('/api/v1/analytics/schedules').set(s.h).send({ frequency: 'WEEKLY', recipientUserIds: [ownerId], isActive: true }).expect(403)).body.feature).toBe('analytics.schedules');
    });

    it('Business (advanced): a year of data, PDF, weekday × hour, top customers', async () => {
      const s = await store('BUSINESS');
      const repeat = phone();
      for (const qty of [1, 2]) {
        const r = (await http.post(`/api/v1/store/${s.slug}/checkout`).send({ customer: { fullName: 'Chidi Obi', phone: repeat }, items: [{ variantId: s.variantId, quantity: qty }], shippingAddress: { line1: '1 Road', city: 'Yaba', state: 'Lagos' } }).expect(201)).body;
        const o = await prisma.order.findFirstOrThrow({ where: { reference: r.reference } });
        const claim = (await http.post(`/api/v1/store/${s.slug}/orders/${r.reference}/transfer`).send({ token: r.trackingToken, payerName: 'Chidi', payerBank: 'Access', payerReference: `0000${uniq()}` }).expect(200)).body;
        await http.post(`/api/v1/orders/${o.id}/transfers/${claim.id}/verify`).set(s.h).send({ amountReceivedMinor: o.totalMinor.toString() }).expect(200);
      }
      const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
      const yearAgo = new Date(Date.now() + 3_600_000 - 365 * DAY).toISOString().slice(0, 10);
      const r = (await http.get(`/api/v1/analytics?from=${yearAgo}&to=${today}`).set(s.h).expect(200)).body;
      expect(r).toMatchObject({ tier: 'advanced', range: { days: 366, bucket: 'month' }, limits: { maxDays: 366, pdf: true, schedules: true } });
      expect(r.topCustomers).toEqual([expect.objectContaining({ name: 'Chidi Obi', paidOrders: 2, spendMinor: '7500000', newInRange: true })]);
      const cells = r.patterns as Array<{ weekday: number; hour: number; orders: number; paidOrders: number }>;
      expect(cells.reduce((n, c) => n + c.orders, 0)).toBe(2);
      expect(cells.every((c) => c.weekday >= 1 && c.weekday <= 7 && c.hour >= 0 && c.hour <= 23)).toBe(true);
      const csv = await http.get('/api/v1/analytics/export?report=customers').set(s.h).expect(200);
      expect(csv.text).toContain('Chidi Obi,2,75000.00,yes');
      expect(csv.text).not.toMatch(/\+234/); // no phone numbers in exports
      await http.get('/api/v1/analytics/report.pdf').set(s.h).expect(200);
    });

    it('scheduled email reports: recipients must read reports; sent once per period after it closes', async () => {
      const s = await store('ENTERPRISE');
      const ownerId = (await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: s.tenantId, role: { key: 'OWNER' } } })).userId;
      const moderator = await member(s.tenantId, 'LIVE_MODERATOR'); // no reports:read
      const manager = await member(s.tenantId, 'STORE_MANAGER'); // reports:read, but not store:manage
      const outsider = await register();
      const outsiderId = (await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: outsider.tenantId } })).userId;
      const list = (await http.get('/api/v1/analytics/schedules').set(s.h).expect(200)).body;
      expect(list.available).toBe(true);
      expect(list.recipients.map((r: { id: string }) => r.id).sort()).toEqual([ownerId, manager.userId].sort());
      await http.put('/api/v1/analytics/schedules').set(s.h).send({ frequency: 'WEEKLY', recipientUserIds: [moderator.userId], isActive: true }).expect(400);
      await http.put('/api/v1/analytics/schedules').set(s.h).send({ frequency: 'WEEKLY', recipientUserIds: [outsiderId], isActive: true }).expect(400);
      await http.put('/api/v1/analytics/schedules').set(s.h).send({ frequency: 'WEEKLY', recipientUserIds: [], isActive: true }).expect(400);
      await http.put('/api/v1/analytics/schedules').set(manager.h).send({ frequency: 'WEEKLY', recipientUserIds: [ownerId], isActive: true }).expect(403);
      const saved = (await http.put('/api/v1/analytics/schedules').set(s.h).send({ frequency: 'WEEKLY', recipientUserIds: [ownerId, manager.userId], isActive: true }).expect(200)).body;
      expect(saved.schedules).toEqual([expect.objectContaining({ frequency: 'WEEKLY', isActive: true, lastPeriod: null })]);

      // Morning (Lagos) of today: last week's report goes out.
      const morning = new Date(`${new Date(Date.now() + 3_600_000).toISOString().slice(0, 10)}T08:00:00+01:00`);
      const before = messaging.sent.length;
      await schedules.runDue(morning);
      const mails = messaging.sent.slice(before).filter((m) => m.channel === 'EMAIL' && m.subject?.includes('Weekly report'));
      const ownerEmail = (await prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).email;
      expect(mails.map((m) => m.to)).toContain(ownerEmail);
      expect(mails).toHaveLength(2);
      expect(mails[0].html).toContain('/analytics?from=');
      const row = await prisma.reportSchedule.findFirstOrThrow({ where: { tenantId: s.tenantId } });
      expect(row.lastPeriod).toMatch(/^\d{4}-W\d{2}$/);
      await schedules.runDue(morning);
      expect(messaging.sent.slice(before).filter((m) => m.subject?.includes('Weekly report') && m.to === ownerEmail)).toHaveLength(1);
      expect(await prisma.notification.count({ where: { tenantId: s.tenantId, type: 'ANALYTICS_REPORT' } })).toBe(2);
      // Before 07:00 Lagos nothing is sent.
      expect(await schedules.runDue(new Date(`${morning.toISOString().slice(0, 10)}T03:00:00+01:00`))).toEqual({ due: 0, sent: 0 });
    });
  });

  // ───────────────────────── Private couriers ─────────────────────────
  describe('private couriers', () => {
    it('the seller keeps their riders and courier companies; picking one fills the delivery; the phone is shared only if chosen', async () => {
      const s = await store();
      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.post('/api/v1/delivery/couriers').set(assistant.h).send({ name: 'Musa' }).expect(403);
      await http.post('/api/v1/delivery/couriers').set(s.h).send({ name: 'Musa', phone: '0803 123' }).expect(400);
      await http.post('/api/v1/delivery/couriers').set(s.h).send({ name: 'M' }).expect(400);
      const musa = (await http.post('/api/v1/delivery/couriers').set(s.h).send({ name: 'Musa (rider)', kind: 'RIDER', phone: '+2348030000001', showPhoneToCustomer: true }).expect(201)).body;
      const gig = (await http.post('/api/v1/delivery/couriers').set(s.h).send({ name: 'Speedy Couriers Ltd', kind: 'COMPANY', phone: '+2348030000002' }).expect(201)).body;
      expect((await http.get('/api/v1/delivery/settings').set(assistant.h).expect(200)).body.couriers.map((c: { name: string }) => c.name)).toEqual(['Musa (rider)', 'Speedy Couriers Ltd']);

      const o = await sale(s, 1);
      const other = await store();
      const otherCourier = (await http.post('/api/v1/delivery/couriers').set(other.h).send({ name: 'Not yours' }).expect(201)).body;
      await http.put(`/api/v1/orders/${o.id}/delivery`).set(s.h).send({ courierId: otherCourier.id }).expect(404);
      const d = (await http.put(`/api/v1/orders/${o.id}/delivery`).set(assistant.h).send({ method: 'SELLER_DELIVERY', courierId: musa.id }).expect(200)).body;
      expect(d.delivery).toMatchObject({ courierId: musa.id, carrierName: 'Musa (rider)', courier: { name: 'Musa (rider)', kind: 'RIDER' } });
      await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(s.h).send({ status: 'IN_TRANSIT' }).expect(200);
      const ev = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: o.id, type: 'ORDER_DISPATCHED' } });
      expect((ev.payload as { note: string }).note).toBe('Sent with Musa (rider) (+2348030000001)');
      const t = (await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${o.token}`).expect(200)).body;
      expect(t.delivery).toMatchObject({ carrierName: 'Musa (rider)', carrierPhone: '+2348030000001' });
      const board = (await http.get(`/api/v1/deliveries?courierId=${musa.id}`).set(s.h).expect(200)).body;
      expect(board.items.map((i: { id: string }) => i.id)).toEqual([o.id]);
      expect((await http.get(`/api/v1/deliveries?courierId=${gig.id}`).set(s.h).expect(200)).body.items).toEqual([]);
      await http.post(`/api/v1/orders/${o.id}/delivery/status`).set(s.h).send({ status: 'DELIVERED' }).expect(200);
      expect((await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${o.token}`).expect(200)).body.delivery.carrierPhone).toBeNull(); // not after delivery

      // A courier company whose phone isn't shared.
      const o2 = await sale(s, 1);
      await http.put(`/api/v1/orders/${o2.id}/delivery`).set(s.h).send({ method: 'THIRD_PARTY', courierId: gig.id, trackingReference: 'SPD-778' }).expect(200);
      await http.post(`/api/v1/orders/${o2.id}/delivery/status`).set(s.h).send({ status: 'IN_TRANSIT' }).expect(200);
      expect(((await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: o2.id, type: 'ORDER_DISPATCHED' } })).payload as { note: string }).note).toBe('Sent with Speedy Couriers Ltd, tracking SPD-778');
      expect((await http.get(`/api/v1/store/${s.slug}/orders/${o2.reference}?token=${o2.token}`).expect(200)).body.delivery.carrierPhone).toBeNull();

      // Removing: couriers who carried orders are switched off; unused ones deleted; switched-off ones can't be picked.
      expect((await http.delete(`/api/v1/delivery/couriers/${musa.id}`).set(s.h).expect(200)).body).toEqual({ removed: true, archived: true });
      const spare = (await http.post('/api/v1/delivery/couriers').set(s.h).send({ name: 'Spare rider' }).expect(201)).body;
      expect((await http.delete(`/api/v1/delivery/couriers/${spare.id}`).set(s.h).expect(200)).body).toEqual({ removed: true, archived: false });
      const o3 = await sale(s, 1);
      await http.put(`/api/v1/orders/${o3.id}/delivery`).set(s.h).send({ courierId: musa.id }).expect(400);
      await http.patch(`/api/v1/delivery/couriers/${musa.id}`).set(other.h).send({ isActive: true }).expect(404);
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: { startsWith: 'delivery.courier_' } } })).toBe(5);
    });
  });
});
