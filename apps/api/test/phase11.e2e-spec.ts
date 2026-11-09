import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { CommissionBillingService, lagosMonthStart } from '../src/billing/commission-billing.service';
import { configureApp } from '../src/configure-app';
import { PaymentProviderRegistry } from '../src/payments/payment-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer, FakePaymentProvider, FakeRegistry } from './support';

const DAY = 86_400_000;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
type H = Record<string, string>;

describe('Phase 11 — super-admin portal', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;
  let admin: H;
  let support: H;

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
    admin = await platformUser('PLATFORM_ADMIN');
    support = await platformUser('PLATFORM_SUPPORT');
  });
  afterAll(async () => app.close());

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p11-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p11-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: 'CorrectHorse42', acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { email: body.email, slug: body.storeUsername, tenantId: res.body.tenant.id as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } as H };
  }
  async function platformUser(role: 'PLATFORM_ADMIN' | 'PLATFORM_SUPPORT') {
    const a = await register();
    await prisma.user.update({ where: { email: a.email }, data: { platformRole: role } });
    return { Authorization: a.h.Authorization };
  }

  it('overview: real platform figures; sellers and support can’t change anything, sellers can’t see it', async () => {
    const s = await register();
    await http.get('/api/v1/admin/overview').set(s.h).expect(403);
    const o = (await http.get('/api/v1/admin/overview').set(support).expect(200)).body;
    expect(o.sellers.total).toBeGreaterThanOrEqual(3);
    expect(o.sellers.active + o.sellers.inactive).toBe(o.sellers.total);
    expect(o.sellers.newLast30Days).toBeGreaterThanOrEqual(3);
    expect(o).toHaveProperty('revenue.subscriptionRevenueMinor');
    expect(o).toHaveProperty('revenue.commissionReceivableMinor');
    expect(o.health).toMatchObject({ database: { status: 'up' }, redis: { status: 'up' } });
    expect(Array.isArray(o.gateways) && Array.isArray(o.topSellers) && Array.isArray(o.subscriptions.byPlan)).toBe(true);
    await http.post(`/api/v1/admin/sellers/${s.tenantId}/suspend`).set(support).send({ reason: 'Support may not do this' }).expect(403);
    await http.put('/api/v1/admin/settings/billing.grace_days').set(support).send({ value: 5 }).expect(403);
  });

  it('sellers: search, detail, suspend blocks the store and storefront at once, reactivate restores it; all audited', async () => {
    const s = await register();
    await http.post('/api/v1/storefront/publish').set(s.h); // may fail checklist; storefront check below uses the API status only
    const list = (await http.get(`/api/v1/admin/sellers?search=${s.slug}`).set(admin).expect(200)).body;
    expect(list.items).toEqual([expect.objectContaining({ id: s.tenantId, slug: s.slug, status: 'TRIAL', subscription: expect.objectContaining({ status: 'TRIALING' }) })]);
    const d = (await http.get(`/api/v1/admin/sellers/${s.tenantId}`).set(support).expect(200)).body;
    expect(d).toMatchObject({ id: s.tenantId, team: [expect.objectContaining({ email: s.email })], sales: { allTimeMinor: '0' } });
    await http.post(`/api/v1/admin/sellers/${s.tenantId}/suspend`).set(admin).send({ reason: 'x' }).expect(400);
    await http.post(`/api/v1/admin/sellers/${s.tenantId}/suspend`).set(admin).send({ reason: 'Fraud reports under review' }).expect(200);
    await http.get('/api/v1/products').set(s.h).expect(403);
    await http.get(`/api/v1/store/${s.slug}`).expect(404);
    await http.post(`/api/v1/admin/sellers/${s.tenantId}/suspend`).set(admin).send({ reason: 'Fraud reports under review' }).expect(409);
    expect((await http.get('/api/v1/admin/sellers?status=SUSPENDED').set(admin).expect(200)).body.items.map((i: { id: string }) => i.id)).toContain(s.tenantId);
    const back = (await http.post(`/api/v1/admin/sellers/${s.tenantId}/reactivate`).set(admin).send({ note: 'Cleared' }).expect(200)).body;
    expect(back.status).toBe('TRIAL');
    await http.get('/api/v1/products').set(s.h).expect(200);
    const audit = (await http.get(`/api/v1/admin/audit?tenantId=${s.tenantId}&action=admin.`).set(support).expect(200)).body;
    expect(audit.items.map((a: { action: string }) => a.action)).toEqual(['admin.seller_reactivated', 'admin.seller_suspended']);
    expect(audit.items[1].metadata).toMatchObject({ reason: 'Fraud reports under review', previousStatus: 'TRIAL' });
    await http.get('/api/v1/admin/sellers/00000000-0000-0000-0000-000000000000').set(admin).expect(404);
  });

  it('commission: open invoices across sellers; waiving writes it off in the ledger, lifts the block, and is never re-billed', async () => {
    const s = await register();
    await http.post('/api/v1/billing/subscription/change').set(s.h).send({ planCode: 'PAY_AS_YOU_SELL', interval: 'MONTHLY' }).expect(200);
    await prisma.subscription.updateMany({ where: { tenantId: s.tenantId }, data: { status: 'ACTIVE', trialEndsAt: null } });
    const bag = (await http.post('/api/v1/products').set(s.h).send({ name: 'Bag', productCode: 'BAG001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '5000000', initialStock: 5 }] }).expect(201)).body;
    await http.patch('/api/v1/store/profile').set(s.h).send({ description: 'Bags', whatsappNumber: '+2348031234567' }).expect(200);
    await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
    await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankName: 'GTBank', accountNumber: '0123456789', accountName: 'ADA LTD' }).expect(201);
    const r = (await http.post(`/api/v1/store/${s.slug}/checkout`).send({ customer: { fullName: 'Amaka', phone: phone() }, items: [{ variantId: bag.variants[0].id, quantity: 1 }], shippingAddress: { line1: '1 Road', city: 'Ikeja', state: 'Lagos' } }).expect(201)).body;
    const o = await prisma.order.findFirstOrThrow({ where: { reference: r.reference } });
    const claim = (await http.post(`/api/v1/store/${s.slug}/orders/${r.reference}/transfer`).send({ token: r.trackingToken, payerName: 'Amaka', payerBank: 'Access', payerReference: `0000${uniq()}` }).expect(200)).body;
    await http.post(`/api/v1/orders/${o.id}/transfers/${claim.id}/verify`).set(s.h).send({ amountReceivedMinor: o.totalMinor.toString() }).expect(200);
    const billing = app.get(CommissionBillingService);
    const nextMonth = new Date(lagosMonthStart(new Date()).getTime() + 40 * DAY);
    const inv = (await billing.issueFor(s.tenantId, nextMonth))!; // 3% of ₦50,000 = ₦1,500
    await prisma.subscriptionInvoice.update({ where: { id: inv.id }, data: { dueAt: new Date(Date.now() - 10 * DAY) } });
    await http.post('/api/v1/products').set(s.h).send({ name: 'Cap', productCode: 'CAP001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '1', initialStock: 1 }] }).expect(402);

    const list = (await http.get('/api/v1/admin/commission?status=OPEN').set(support).expect(200)).body;
    expect(list.items.find((i: { id: string }) => i.id === inv.id)).toMatchObject({ amountMinor: '150000', overdue: true, store: { id: s.tenantId } });
    await http.post(`/api/v1/admin/commission/invoices/${inv.id}/waive`).set(support).send({ reason: 'Goodwill for launch month' }).expect(403);
    const w = (await http.post(`/api/v1/admin/commission/invoices/${inv.id}/waive`).set(admin).send({ reason: 'Goodwill for launch month' }).expect(200)).body;
    expect(w.status).toBe('UNCOLLECTIBLE');
    await http.post(`/api/v1/admin/commission/invoices/${inv.id}/waive`).set(admin).send({ reason: 'Goodwill for launch month' }).expect(409);
    await http.post('/api/v1/products').set(s.h).send({ name: 'Cap', productCode: 'CAP001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '1', initialStock: 1 }] }).expect(201);
    const bal = async (tenantId: string | null, code: string) => (await prisma.ledgerEntry.findMany({ where: { account: { tenantId, code } } })).reduce((t, e) => t + (e.direction === 'DEBIT' ? e.amountMinor : -e.amountMinor), 0n);
    expect(await bal(s.tenantId, 'COMMISSION_PAYABLE')).toBe(0n);
    // Not billed again next time.
    expect(await billing.issueFor(s.tenantId, new Date(nextMonth.getTime() + 31 * DAY))).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'admin.commission_waived', entityId: inv.id } })).toBe(1);
  });

  it('settings: validated, audited; webhooks and health are visible', async () => {
    const before = (await http.get('/api/v1/admin/settings').set(support).expect(200)).body as Array<{ key: string; value: unknown }>;
    const grace = before.find((x) => x.key === 'billing.grace_days')!;
    await http.put('/api/v1/admin/settings/billing.grace_days').set(admin).send({ value: 99 }).expect(400);
    await http.put('/api/v1/admin/settings/billing.grace_days').set(admin).send({ value: '4' }).expect(400);
    await http.put('/api/v1/admin/settings/nope').set(admin).send({ value: 1 }).expect(404);
    await http.put('/api/v1/admin/settings/billing.reminder_days').set(admin).send({ value: [7, 0] }).expect(400);
    const after = (await http.put('/api/v1/admin/settings/billing.grace_days').set(admin).send({ value: 4 }).expect(200)).body;
    expect(after.find((x: { key: string }) => x.key === 'billing.grace_days').value).toBe(4);
    expect(await prisma.auditLog.count({ where: { action: 'admin.setting_changed', entityId: 'billing.grace_days' } })).toBeGreaterThan(0);
    await http.put('/api/v1/admin/settings/billing.grace_days').set(admin).send({ value: grace.value ?? 3 }).expect(200); // restore

    await prisma.paymentWebhookEvent.create({ data: { provider: 'PAYSTACK', eventId: `p11-${uniq()}`, eventType: 'charge.success', signatureValid: false, payload: {}, status: 'IGNORED', error: 'Bad signature' } });
    const wh = (await http.get('/api/v1/admin/webhooks?invalidOnly=true').set(support).expect(200)).body;
    expect(wh.items[0]).toMatchObject({ signatureValid: false, error: 'Bad signature' });
    expect(wh.items[0]).not.toHaveProperty('payload');
    expect((await http.get('/api/v1/admin/health').set(support).expect(200)).body).toMatchObject({ database: { status: 'up' } });
  });
});
