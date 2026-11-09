import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { configureApp } from '../src/configure-app';
import { LedgerService } from '../src/ledger/ledger.service';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentProviderRegistry } from '../src/payments/payment-provider';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer, FakePaymentProvider, FakeRegistry, signWebhook } from './support';

const PASSWORD = 'CorrectHorse42';
const PLATFORM_KEY = 'sk_test_e2eplatformplaceholder';
const SELLER_KEY = 'sk_test_sellerownkey0123456789';
const SELLER_PK = 'pk_test_sellerownkey0123456789';
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
type H = Record<string, string>;

describe('Phase 5 — payments (Paystack via the provider port)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let orders: OrdersService;
  let crypto: CryptoService;
  let http: ReturnType<typeof request>;
  const fake = new FakePaymentProvider();
  fake.validKeys.add(SELLER_KEY);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer).useValue(new CapturingMailer())
      .overrideProvider(BillingNotifier).useValue(new CapturingBillingNotifier())
      .overrideProvider(PaymentProviderRegistry).useValue(new FakeRegistry(fake))
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);
    orders = app.get(OrdersService);
    crypto = app.get(CryptoService);
    http = request(app.getHttpServer());
    await setProvider(true);
  });
  afterAll(async () => {
    await setProvider(false); // other suites expect the seeded default (disabled)
    await app.close();
  });
  beforeEach(() => { fake.down = false; fake.refundDecline = null; });

  const setProvider = (isEnabled: boolean) => prisma.paymentProvider.update({ where: { code: 'PAYSTACK' }, data: { isEnabled } });

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p5-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p5-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { email: body.email, slug: body.storeUsername, tenantId: res.body.tenant.id as string, token: res.body.accessToken as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } as H };
  }
  async function member(tenantId: string, roleKey: string): Promise<H> {
    const other = await register();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId, key: roleKey } });
    const m = await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    await prisma.tenantMember.create({ data: { tenantId, userId: m.userId, roleId: role.id } });
    return { Authorization: other.h.Authorization, 'X-Tenant-Id': tenantId };
  }
  /** Published store, BAG001 ₦25,000 × 5, connected to its own Paystack account unless `mode` says otherwise. */
  async function store(mode: 'direct' | 'split' | 'none' = 'direct') {
    const s = await register();
    const bag = (await http.post('/api/v1/products').set(s.h).send({
      name: 'Leather Bag', productCode: 'BAG001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '2500000', initialStock: 5 }],
    }).expect(201)).body;
    await http.patch('/api/v1/store/profile').set(s.h).send({ description: 'Bags', whatsappNumber: '+2348031234567' }).expect(200);
    await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
    if (mode === 'direct') await http.put('/api/v1/payments/settings/paystack/direct').set(s.h).send({ secretKey: SELLER_KEY, publicKey: SELLER_PK }).expect(200);
    if (mode === 'split') {
      fake.resolvable.set('0123456789', 'ADA FASHION LTD');
      await http.put('/api/v1/payments/settings/paystack/split').set(s.h).send({ bankCode: '058', accountNumber: '0123456789' }).expect(200);
    }
    return { ...s, variantId: bag.variants[0].id as string };
  }
  async function checkout(s: { slug: string; variantId: string }, qty = 1, email?: string) {
    const r = await http.post(`/api/v1/store/${s.slug}/checkout`).send({
      customer: { fullName: 'Amaka Nnaji', phone: phone(), ...(email ? { email } : {}) }, items: [{ variantId: s.variantId, quantity: qty }],
      shippingAddress: { line1: '3 Bode Thomas', city: 'Surulere', state: 'Lagos' },
    }).expect(201);
    const o = await prisma.order.findFirstOrThrow({ where: { reference: r.body.reference } });
    return { reference: r.body.reference as string, token: r.body.trackingToken as string, id: o.id, total: o.totalMinor };
  }
  const pay = (slug: string, o: { reference: string; token: string }, email = 'amaka@example.com') =>
    http.post(`/api/v1/store/${slug}/orders/${o.reference}/pay`).send({ token: o.token, email });
  const verify = (reference: string) => http.post('/api/v1/payments/verify').send({ reference });
  const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
  const stock = (variantId: string) => prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  const txn = (reference: string) => prisma.paymentTransaction.findUniqueOrThrow({ where: { reference } });
  async function ledger(transactionId: string) {
    const rows = await prisma.ledgerEntry.findMany({ where: { transactionId }, include: { account: true } });
    const by = (tenant: 'seller' | 'platform', code: string) => rows
      .filter((r) => r.account.code === code && (tenant === 'platform' ? r.account.tenantId === null : r.account.tenantId !== null))
      .reduce((s, r) => s + (r.direction === 'DEBIT' ? r.amountMinor : -r.amountMinor), 0n);
    const balanced = [...new Set(rows.map((r) => r.journalId))].every((j) => rows.filter((r) => r.journalId === j).reduce((s, r) => s + (r.direction === 'DEBIT' ? r.amountMinor : -r.amountMinor), 0n) === 0n);
    return { rows, by, balanced, journals: new Set(rows.map((r) => r.journalId)).size };
  }
  async function paidOrder(s: Awaited<ReturnType<typeof store>>, qty = 1) {
    const o = await checkout(s, qty);
    const link = (await pay(s.slug, o).expect(200)).body;
    fake.succeed(link.reference, o.total);
    expect((await verify(link.reference).expect(200)).body.status).toBe('SUCCEEDED');
    return { ...o, payRef: link.reference as string };
  }

  // ───────────────────────── Settings ─────────────────────────
  describe('seller payment settings', () => {
    it('connects the seller’s own Paystack account: key checked with Paystack, stored encrypted, never returned', async () => {
      const s = await store('none');
      const put = (body: object) => http.put('/api/v1/payments/settings/paystack/direct').set(s.h).send(body);
      expect((await put({ secretKey: 'nonsense', publicKey: SELLER_PK }).expect(400)).body.code).toBe('INVALID_KEY_FORMAT');
      expect((await put({ secretKey: SELLER_KEY, publicKey: 'pk_live_sellerownkey0123456789' }).expect(400)).body.code).toBe('KEY_MODE_MISMATCH');
      expect((await put({ secretKey: 'sk_test_notacceptedbypaystack1', publicKey: SELLER_PK }).expect(422)).body.code).toBe('INVALID_KEY');
      const r = await put({ secretKey: SELLER_KEY, publicKey: SELLER_PK }).expect(200);
      expect(JSON.stringify(r.body)).not.toContain(SELLER_KEY);
      expect(r.body.account).toMatchObject({ mode: 'DIRECT', isActive: true, testMode: true, hasSecretKey: true, publicKey: SELLER_PK });
      expect(r.body.account.webhookUrl).toMatch(new RegExp(`/api/v1/payments/paystack/webhook/${r.body.account.id}$`));
      const row = await prisma.sellerPaymentAccount.findFirstOrThrow({ where: { tenantId: s.tenantId } });
      expect(row.credentialsEnc).not.toContain(SELLER_KEY);
      expect(JSON.parse(crypto.decrypt(row.credentialsEnc!, s.tenantId))).toEqual({ secretKey: SELLER_KEY }); // encrypted JSON since Phase 6
      expect(() => crypto.decrypt(row.credentialsEnc!, 'another-tenant')).toThrow(); // bound to this tenant
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: s.tenantId, action: 'payments.account_connected' } });
      expect(JSON.stringify(audit.metadata)).not.toContain(SELLER_KEY);
      const get = (await http.get('/api/v1/payments/settings').set(s.h).expect(200)).body;
      expect(JSON.stringify(get)).not.toContain('sk_test');

      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.put('/api/v1/payments/settings/paystack/direct').set(assistant).send({ secretKey: SELLER_KEY, publicKey: SELLER_PK }).expect(403);
      const manager = await member(s.tenantId, 'STORE_MANAGER');
      await http.get('/api/v1/payments/settings').set(manager).expect(200); // payments:read
      await http.post('/api/v1/payments/settings/paystack/active').set(manager).send({ isActive: false }).expect(403);
    });

    it('split settlement: account name confirmed with the bank, subaccount created, account number encrypted', async () => {
      const s = await store('none');
      const put = (body: object) => http.put('/api/v1/payments/settings/paystack/split').set(s.h).send(body);
      await put({ bankCode: '058', accountNumber: '12345' }).expect(400);
      expect((await put({ bankCode: '999', accountNumber: '0123456780' }).expect(400)).body.code).toBe('UNKNOWN_BANK');
      expect((await put({ bankCode: '058', accountNumber: '0000000001' }).expect(422)).body.code).toBe('ACCOUNT_NOT_RESOLVED');
      fake.resolvable.set('0123456780', 'ADA FASHION LTD');
      const r = (await put({ bankCode: '058', accountNumber: '0123456780' }).expect(200)).body;
      expect(r.account).toMatchObject({ mode: 'SPLIT', subaccountCode: expect.stringMatching(/^ACCT_/), bankAccount: { bankName: 'Guaranty Trust Bank', accountName: 'ADA FASHION LTD', last4: '6780' }, webhookUrl: null });
      const bank = await prisma.bankAccount.findFirstOrThrow({ where: { tenantId: s.tenantId } });
      expect(bank.accountNumberEnc).not.toContain('0123456780');
      expect(crypto.decrypt(bank.accountNumberEnc, s.tenantId)).toBe('0123456780');
    });

    it('turning online payment off hides "Pay now" and refuses new links', async () => {
      const s = await store();
      const o = await checkout(s);
      expect((await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${o.token}`).expect(200)).body.onlinePayment).toMatchObject({ online: true, provider: 'PAYSTACK', testMode: true });
      await http.post('/api/v1/payments/settings/paystack/active').set(s.h).send({ isActive: false }).expect(200);
      expect((await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${o.token}`)).body.onlinePayment.online).toBe(false);
      expect((await pay(s.slug, o).expect(409)).body.code).toBe('PAYMENTS_NOT_SET_UP');
    });

    it('platform admin controls providers; only integrated providers can be enabled', async () => {
      const s = await register();
      await http.get('/api/v1/admin/payment-providers').set({ Authorization: s.h.Authorization }).expect(403);
      await prisma.user.update({ where: { email: s.email }, data: { platformRole: 'PLATFORM_ADMIN' } });
      const admin = { Authorization: s.h.Authorization };
      const list = (await http.get('/api/v1/admin/payment-providers').set(admin).expect(200)).body;
      expect(list.find((p: any) => p.code === 'PAYSTACK')).toMatchObject({ isEnabled: true, adapterAvailable: true, platformKeyConfigured: true });
      expect(list.find((p: any) => p.code === 'FLUTTERWAVE')).toMatchObject({ adapterAvailable: false });
      expect((await http.patch('/api/v1/admin/payment-providers/flutterwave').set(admin).send({ isEnabled: true }).expect(409)).body.code).toBe('ADAPTER_NOT_AVAILABLE');
      await http.patch('/api/v1/admin/payment-providers/nope').set(admin).send({ isEnabled: true }).expect(404);

      const shop = await store();
      const o = await checkout(shop);
      await http.patch('/api/v1/admin/payment-providers/paystack').set(admin).send({ isEnabled: false }).expect(200);
      expect((await pay(shop.slug, o).expect(503)).body.code).toBe('PAYMENTS_NOT_ENABLED');
      await http.patch('/api/v1/admin/payment-providers/paystack').set(admin).send({ isEnabled: true }).expect(200);
      expect(await prisma.auditLog.count({ where: { action: 'platform.payment_provider_updated', actorId: (await prisma.user.findUniqueOrThrow({ where: { email: s.email } })).id } })).toBe(2);
    });
  });

  // ───────────────────────── Paying ─────────────────────────
  describe('order payment and verification', () => {
    it('customer pays: link → redirect → server-side verify → PAID with a balanced ledger, once', async () => {
      const s = await store();
      const o = await checkout(s, 2);
      expect((await pay(s.slug, o, '').expect(400)).body.message).toBeDefined();
      expect((await http.post(`/api/v1/store/${s.slug}/orders/${o.reference}/pay`).send({ token: o.token }).expect(400)).body.code).toBe('EMAIL_REQUIRED');
      await http.post(`/api/v1/store/${s.slug}/orders/${o.reference}/pay`).send({ token: 'wrong-token', email: 'a@example.com' }).expect(404);

      const link = (await pay(s.slug, o).expect(200)).body;
      expect(link).toMatchObject({ checkoutUrl: expect.stringContaining('checkout.paystack.test'), amountMinor: '5000000', currency: 'NGN', reused: false });
      const init = fake.initialized.at(-1)!;
      expect(init.creds.secretKey).toBe(SELLER_KEY); // direct settlement uses the seller's own key
      expect(init.input).toMatchObject({ amountMinor: 5_000_000n, currency: 'NGN', customerEmail: 'amaka@example.com', callbackUrl: 'http://localhost:3000/payments/return' });
      expect(init.input.split).toBeUndefined();
      expect((await pay(s.slug, o).expect(200)).body).toMatchObject({ reference: link.reference, reused: true }); // same link, no second charge

      // Returning from Paystack proves nothing: the provider still says "abandoned".
      expect((await verify(link.reference).expect(200)).body).toMatchObject({ status: 'ABANDONED', kind: 'order', orderReference: o.reference });
      expect((await order(o.id)).status).toBe('PENDING_PAYMENT');

      fake.succeed(link.reference, 5_000_000n, { feeMinor: 85_000n });
      const r = (await verify(link.reference).expect(200)).body;
      expect(r).toMatchObject({ status: 'SUCCEEDED', amountMinor: '5000000', store: { slug: s.slug } });
      const paid = await order(o.id);
      expect(paid).toMatchObject({ status: 'PAID', paymentStatus: 'PAID', reservationExpiresAt: null });
      const t = await txn(link.reference);
      expect(t).toMatchObject({ status: 'SUCCEEDED', providerFeeMinor: 85_000n, platformCommissionMinor: 0n, sellerProceedsMinor: 4_915_000n, settlementMode: 'DIRECT', verifiedBy: 'paystack:return', failureReason: null });
      const l = await ledger(t.id);
      expect(l.balanced).toBe(true);
      expect(l.by('seller', 'SALES_REVENUE')).toBe(-5_000_000n);
      expect(l.by('seller', 'PAYMENT_FEES')).toBe(85_000n);
      expect(l.by('seller', 'GATEWAY_CLEARING')).toBe(4_915_000n);

      // Every path again: nothing changes.
      await verify(link.reference).expect(200);
      await payments.verifyReference(link.reference, 'reconcile');
      await http.post(`/api/v1/orders/${o.id}/payments/verify`).set(s.h).expect(200);
      expect((await ledger(t.id)).rows.length).toBe(l.rows.length);
      expect(await prisma.orderStatusHistory.count({ where: { orderId: o.id, toStatus: 'PAID' } })).toBe(1);
      expect((await pay(s.slug, o).expect(409)).body.code).toBe('ORDER_NOT_PAYABLE');
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'payment.verified' } })).toBe(1);

      const detail = (await http.get(`/api/v1/orders/${o.id}`).set(s.h).expect(200)).body;
      expect(detail.transactions[0]).toMatchObject({ reference: link.reference, status: 'SUCCEEDED', sellerProceedsMinor: '4915000' });
      const tracked = (await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${o.token}`)).body;
      expect(tracked).toMatchObject({ status: 'PAID', paymentStatus: 'PAID', onlinePayment: { online: false } });
    });

    it('staff send a payment link for a phone order; the reconciliation job confirms it', async () => {
      const s = await store();
      const created = (await http.post('/api/v1/orders').set(s.h).send({ customer: { fullName: 'Bola Ade', phone: phone(), email: 'bola@example.com' }, items: [{ variantId: s.variantId, quantity: 1 }] }).expect(201)).body;
      const link = (await http.post(`/api/v1/orders/${created.id}/payment-link`).set(s.h).send({}).expect(200)).body;
      expect(fake.initialized.at(-1)!.input.customerEmail).toBe('bola@example.com');
      const moderator = await member(s.tenantId, 'LIVE_MODERATOR');
      await http.post(`/api/v1/orders/${created.id}/payment-link`).set(moderator).send({}).expect(200); // orders:create
      fake.succeed(link.reference, 2_500_000n);
      // Not yet due for reconciliation (created < 2 minutes ago) …
      await payments.reconcile(new Date());
      expect((await order(created.id)).status).toBe('PENDING_PAYMENT');
      // … a few minutes later it is.
      const out = await payments.reconcile(new Date(Date.now() + 5 * 60_000));
      expect(out.succeeded).toBeGreaterThanOrEqual(1);
      expect((await order(created.id)).status).toBe('PAID');
      expect((await txn(link.reference)).verifiedBy).toBe('paystack:reconcile');
    });

    it('a short payment is never accepted (amount/currency must match what we asked for)', async () => {
      const s = await store();
      const o = await checkout(s);
      const link = (await pay(s.slug, o).expect(200)).body;
      fake.succeed(link.reference, 2_499_999n);
      expect((await verify(link.reference).expect(200)).body.status).toBe('FAILED');
      expect(await txn(link.reference)).toMatchObject({ status: 'FAILED', failureReason: 'AMOUNT_MISMATCH' });
      expect((await order(o.id)).status).toBe('PENDING_PAYMENT');
      expect(await prisma.ledgerEntry.count({ where: { transactionId: (await txn(link.reference)).id } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'payment.amount_mismatch' } })).toBe(1);

      const o2 = await checkout(s);
      const l2 = (await pay(s.slug, o2).expect(200)).body;
      fake.succeed(l2.reference, o2.total, { currency: 'USD' });
      expect((await verify(l2.reference)).body.status).toBe('FAILED');
      expect((await order(o2.id)).status).toBe('PENDING_PAYMENT');
    });

    it('§26 #4 failed payment: order stays awaiting payment and the customer can try again', async () => {
      const s = await store();
      const o = await checkout(s);
      const first = (await pay(s.slug, o).expect(200)).body;
      fake.verifications.set(first.reference, { status: 'FAILED', message: 'Declined' });
      expect((await verify(first.reference).expect(200)).body.status).toBe('FAILED');
      expect(await txn(first.reference)).toMatchObject({ status: 'FAILED', failureReason: 'Declined' });
      expect(await order(o.id)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'PENDING' });
      expect((await stock(s.variantId)).reserved).toBe(1);
      const second = (await pay(s.slug, o).expect(200)).body;
      expect(second.reference).not.toBe(first.reference);
      fake.succeed(second.reference, o.total);
      await verify(second.reference).expect(200);
      expect((await order(o.id)).status).toBe('PAID');
    });

    it('§26 #11 provider unavailable: nothing is charged or changed, and the customer is told to retry', async () => {
      const s = await store();
      const o = await checkout(s);
      fake.down = true;
      const r = await pay(s.slug, o).expect(503);
      expect(r.body.code).toBe('PROVIDER_UNAVAILABLE');
      expect(await order(o.id)).toMatchObject({ status: 'PENDING_PAYMENT' });
      const t = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId: o.id } });
      expect(t).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_UNAVAILABLE', checkoutUrl: null });

      fake.down = false;
      const link = (await pay(s.slug, o).expect(200)).body;
      fake.succeed(link.reference, o.total);
      fake.down = true;
      expect((await verify(link.reference).expect(200)).body).toMatchObject({ status: 'PENDING', providerDown: true });
      await http.post(`/api/v1/orders/${o.id}/payments/verify`).set(s.h).expect(503);
      expect((await order(o.id)).status).toBe('PENDING_PAYMENT');
      fake.down = false;
      await verify(link.reference).expect(200);
      expect((await order(o.id)).status).toBe('PAID');
    });

    it('keeps the stock hold alive while the customer is paying', async () => {
      const s = await store();
      const o = await checkout(s);
      await prisma.order.update({ where: { id: o.id }, data: { reservationExpiresAt: new Date(Date.now() + 60_000) } });
      await pay(s.slug, o).expect(200);
      expect((await order(o.id)).reservationExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    });

    it('§26 #2 a payment that lands after the hold expired is recorded, not applied, and flagged for a refund', async () => {
      const s = await store();
      const o = await checkout(s);
      const link = (await pay(s.slug, o).expect(200)).body;
      await prisma.order.update({ where: { id: o.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
      await orders.expireReservations(new Date());
      expect((await order(o.id)).status).toBe('CANCELLED');
      expect((await stock(s.variantId)).reserved).toBe(0);

      fake.succeed(link.reference, o.total);
      const r = (await verify(link.reference).expect(200)).body;
      expect(r.status).toBe('SUCCEEDED');
      expect(await order(o.id)).toMatchObject({ status: 'CANCELLED' }); // not revived
      expect((await stock(s.variantId)).reserved).toBe(0);
      const t = await txn(link.reference);
      expect(t.failureReason).toBe('ORDER_NOT_PAYABLE');
      expect((await ledger(t.id)).by('seller', 'SALES_REVENUE')).toBe(-o.total); // the money did arrive
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'payment.needs_refund' } })).toBe(1);
      const notes = await prisma.orderStatusHistory.findMany({ where: { orderId: o.id, note: { contains: 'Refund it' } } });
      expect(notes).toHaveLength(1);

      // The seller refunds it; the order stays cancelled.
      const rf = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(201)).body.refund;
      fake.refunds.set(rf.providerReference, 'SUCCEEDED');
      await payments.reconcile(new Date());
      expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { id: rf.id } })).toMatchObject({ status: 'SUCCEEDED' });
      expect((await order(o.id)).status).toBe('CANCELLED');
    });

    it('two payments for one order: the second is recorded and flagged as a duplicate', async () => {
      const s = await store();
      const o = await checkout(s);
      const a = (await pay(s.slug, o).expect(200)).body;
      await prisma.paymentTransaction.update({ where: { reference: a.reference }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } }); // link expired → new one
      const b = (await pay(s.slug, o).expect(200)).body;
      expect(b.reference).not.toBe(a.reference);
      fake.succeed(a.reference, o.total);
      fake.succeed(b.reference, o.total);
      await verify(a.reference).expect(200);
      await verify(b.reference).expect(200);
      expect((await txn(a.reference)).failureReason).toBeNull();
      expect((await txn(b.reference)).failureReason).toBe('DUPLICATE_PAYMENT');
      expect(await prisma.orderStatusHistory.count({ where: { orderId: o.id, toStatus: 'PAID', fromStatus: { not: 'PAID' } } })).toBe(1); // paid once
      expect(await prisma.orderStatusHistory.count({ where: { orderId: o.id, note: { contains: 'already paid' } } })).toBe(1); // second payment noted
    });
  });

  // ───────────────────────── Split settlement & commission ─────────────────────────
  describe('commission', () => {
    it('split settlement on a commission plan: platform charge sent to Paystack, both ledgers balanced', async () => {
      const s = await store('split');
      const sub = await prisma.subscription.findFirstOrThrow({ where: { tenantId: s.tenantId } });
      const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'PAY_AS_YOU_SELL' } });
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', planId: plan.id, trialEndsAt: null } });
      const o = await checkout(s, 3); // ₦75,000
      const link = (await pay(s.slug, o).expect(200)).body;
      const init = fake.initialized.at(-1)!;
      expect(init.creds.secretKey).toBe(PLATFORM_KEY);
      const expected = (7_500_000n * BigInt(plan.commissionBps!)) / 10_000n; // 3% → ₦2,250
      expect(init.input.split).toEqual({ subaccountCode: expect.stringMatching(/^ACCT_/), platformChargeMinor: expected });

      fake.succeed(link.reference, 7_500_000n, { feeMinor: 122_500n });
      await verify(link.reference).expect(200);
      const t = await txn(link.reference);
      expect(t).toMatchObject({ settlementMode: 'SPLIT', platformCommissionMinor: expected, providerFeeMinor: 122_500n, sellerProceedsMinor: 7_500_000n - expected - 122_500n });
      const l = await ledger(t.id);
      expect(l.balanced).toBe(true);
      expect(l.journals).toBe(2);
      expect(l.by('seller', 'COMMISSION_EXPENSE')).toBe(expected);
      expect(l.by('platform', 'COMMISSION_REVENUE')).toBe(-expected);
      expect(l.by('platform', 'PLATFORM_GATEWAY_CLEARING')).toBe(expected);

      // Refund half: commission reversed in proportion; refund the rest: reversed exactly in full.
      const half = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '3750000', reason: 'One bag damaged' }).expect(201)).body.refund;
      fake.refunds.set(half.providerReference, 'SUCCEEDED');
      await payments.reconcile(new Date());
      expect((await order(o.id)).status).toBe('PARTIALLY_REFUNDED');
      const rest = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(201)).body.refund;
      expect(rest.amountMinor).toBe('3750000');
      fake.refunds.set(rest.providerReference, 'SUCCEEDED');
      await payments.reconcile(new Date());
      const after = await ledger(t.id);
      expect(after.balanced).toBe(true);
      expect(after.by('platform', 'COMMISSION_REVENUE')).toBe(0n);
      expect(after.by('seller', 'COMMISSION_EXPENSE')).toBe(0n);
      expect(after.by('seller', 'SALES_REFUNDS')).toBe(7_500_000n);
      expect(await order(o.id)).toMatchObject({ status: 'REFUNDED', paymentStatus: 'REFUNDED' });
    });

    it('no commission during the free trial', async () => {
      const s = await store();
      const o = await paidOrder(s);
      expect((await txn(o.payRef)).platformCommissionMinor).toBe(0n);
      expect((await ledger((await txn(o.payRef)).id)).journals).toBe(1);
    });
  });

  // ───────────────────────── Refunds ─────────────────────────
  describe('§26 #12 refunds', () => {
    it('partial then full refund, provider-confirmed, idempotent, stock released only for goods that never left', async () => {
      const s = await store();
      const o = await paidOrder(s, 2);
      expect((await stock(s.variantId)).reserved).toBe(2);
      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.post(`/api/v1/orders/${o.id}/refunds`).set(assistant).send({}).expect(403);
      await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '0' }).expect(400);
      await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '-5' }).expect(400);
      expect((await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '5000001' }).expect(400)).body.code).toBe('REFUND_TOO_LARGE');

      const key = { 'Idempotency-Key': `refund-${uniq()}` };
      const first = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).set(key).send({ amountMinor: '1000000', reason: 'Late delivery' }).expect(201)).body;
      expect(first).toMatchObject({ duplicate: false, refund: { status: 'PROCESSING', amountMinor: '1000000' } });
      const again = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).set(key).send({ amountMinor: '1000000' }).expect(201)).body;
      expect(again).toMatchObject({ duplicate: true, refund: { id: first.refund.id } });
      expect(fake.refundCalls.filter((c) => c.reference === o.payRef)).toHaveLength(1);
      // Not completed yet: order unchanged, no ledger reversal.
      expect((await order(o.id)).status).toBe('PAID');
      const t = await txn(o.payRef);
      expect((await ledger(t.id)).by('seller', 'SALES_REFUNDS')).toBe(0n);
      // The amount in flight counts against what can still be refunded.
      expect((await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '4000001' }).expect(400)).body.remainingMinor).toBe('4000000');

      fake.refunds.set(first.refund.providerReference, 'SUCCEEDED');
      expect((await payments.reconcile(new Date())).refundsSettled).toBeGreaterThanOrEqual(1);
      await payments.reconcile(new Date()); // again: no double posting
      expect(await order(o.id)).toMatchObject({ status: 'PARTIALLY_REFUNDED', paymentStatus: 'PARTIALLY_REFUNDED' });
      expect((await ledger(t.id)).by('seller', 'SALES_REFUNDS')).toBe(1_000_000n);
      expect((await stock(s.variantId)).reserved).toBe(2);

      const rest = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(201)).body.refund;
      expect(rest.amountMinor).toBe('4000000');
      fake.refunds.set(rest.providerReference, 'SUCCEEDED');
      await payments.reconcile(new Date());
      expect(await order(o.id)).toMatchObject({ status: 'REFUNDED', paymentStatus: 'REFUNDED' });
      expect(await stock(s.variantId)).toMatchObject({ onHand: 5, reserved: 0 });
      const l = await ledger(t.id);
      expect(l.balanced).toBe(true);
      expect(l.by('seller', 'SALES_REFUNDS')).toBe(5_000_000n);
      expect(l.by('seller', 'GATEWAY_CLEARING')).toBe(5_000_000n - 1_500n - 5_000_000n); // only the gateway fee stays lost
      expect((await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(409)).body.code).toBe('FULLY_REFUNDED');
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'payment.refunded' } })).toBe(2);
    });

    it('refund of dispatched goods keeps stock as sold; declined refunds are reported and free the amount again', async () => {
      const s = await store();
      const o = await paidOrder(s);
      await http.post(`/api/v1/orders/${o.id}/status`).set(s.h).send({ status: 'DISPATCHED' }).expect(200);
      expect(await stock(s.variantId)).toMatchObject({ onHand: 4, reserved: 0 });
      fake.refundDecline = 'Transaction has been fully reversed';
      expect((await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(422)).body.code).toBe('REFUND_DECLINED');
      fake.refundDecline = null;
      fake.down = true;
      expect((await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(503)).body.code).toBe('PROVIDER_UNAVAILABLE');
      fake.down = false;
      const rf = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(201)).body.refund;
      expect(rf.amountMinor).toBe('2500000'); // failed attempts don't use up the refundable amount
      fake.refunds.set(rf.providerReference, 'SUCCEEDED');
      await payments.reconcile(new Date());
      expect((await order(o.id)).status).toBe('REFUNDED');
      expect(await stock(s.variantId)).toMatchObject({ onHand: 4, reserved: 0 }); // goods left; returns are Phase 10
    });

    it('a refund the provider fails changes nothing; orders without a verified payment can’t be refunded', async () => {
      const s = await store();
      const o = await paidOrder(s);
      const rf = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '100000' }).expect(201)).body.refund;
      fake.refunds.set(rf.providerReference, 'FAILED');
      await payments.reconcile(new Date());
      expect((await prisma.paymentRefund.findUniqueOrThrow({ where: { id: rf.id } })).status).toBe('FAILED');
      expect((await order(o.id)).status).toBe('PAID');
      const unpaid = await checkout(s);
      expect((await http.post(`/api/v1/orders/${unpaid.id}/refunds`).set(s.h).send({}).expect(409)).body.code).toBe('NOTHING_TO_REFUND');
    });
  });

  // ───────────────────────── Webhooks ─────────────────────────
  describe('§26 #3 webhooks', () => {
    const hook = (path: string, secret: string, payload: unknown) => {
      const { body, signature } = signWebhook(secret, payload);
      return http.post(`/api/v1/payments/paystack/webhook${path}`).set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(body);
    };

    it('a signed webhook triggers verification; duplicates are ignored; forged ones are refused', async () => {
      const s = await store();
      const acc = await prisma.sellerPaymentAccount.findFirstOrThrow({ where: { tenantId: s.tenantId } });
      const o = await checkout(s);
      const link = (await pay(s.slug, o).expect(200)).body;
      const event = { event: 'charge.success', data: { id: 9_000_001 + seq++, reference: link.reference, status: 'success', amount: 1 } };

      // The body claims success but Paystack's verify says otherwise → not paid (payload never trusted for money).
      expect((await hook(`/${acc.id}`, SELLER_KEY, event).expect(200)).body).toMatchObject({ processed: true });
      expect((await order(o.id)).status).toBe('PENDING_PAYMENT');

      fake.succeed(link.reference, o.total);
      const replay = { ...event, data: { ...event.data, id: event.data.id + 1 } };
      await hook(`/${acc.id}`, SELLER_KEY, replay).expect(200);
      expect((await order(o.id)).status).toBe('PAID');
      expect((await txn(link.reference)).verifiedBy).toBe('paystack:webhook');
      const ledgerRows = (await ledger((await txn(link.reference)).id)).rows.length;

      expect((await hook(`/${acc.id}`, SELLER_KEY, replay).expect(200)).body).toMatchObject({ duplicate: true });
      expect((await ledger((await txn(link.reference)).id)).rows.length).toBe(ledgerRows);
      expect(await prisma.paymentWebhookEvent.count({ where: { eventId: `charge.success:${replay.data.id}:success` } })).toBe(1);

      await hook(`/${acc.id}`, 'sk_test_forgedforgedforged', replay).expect(401);
      await hook('', SELLER_KEY, replay).expect(401); // seller-signed event on the platform route
      await http.post(`/api/v1/payments/paystack/webhook/${acc.id}`).set('Content-Type', 'application/json').send(JSON.stringify(replay)).expect(401);
    });

    it('a webhook for another account’s payment is ignored', async () => {
      const a = await store();
      const b = await store();
      const accB = await prisma.sellerPaymentAccount.findFirstOrThrow({ where: { tenantId: b.tenantId } });
      const o = await checkout(a);
      const link = (await pay(a.slug, o).expect(200)).body;
      fake.succeed(link.reference, o.total);
      const r = await hook(`/${accB.id}`, SELLER_KEY, { event: 'charge.success', data: { id: 9_100_000 + seq++, reference: link.reference, status: 'success' } }).expect(200);
      expect(r.body).toMatchObject({ processed: false });
      expect((await order(o.id)).status).toBe('PENDING_PAYMENT');
    });

    it('platform webhook settles split payments; refund webhooks settle refunds', async () => {
      const s = await store('split');
      const o = await checkout(s);
      const link = (await pay(s.slug, o).expect(200)).body;
      fake.succeed(link.reference, o.total);
      await hook('', PLATFORM_KEY, { event: 'charge.success', data: { id: 9_200_000 + seq++, reference: link.reference, status: 'success' } }).expect(200);
      expect((await order(o.id)).status).toBe('PAID');

      const rf = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(201)).body.refund;
      fake.refunds.set(rf.providerReference, 'SUCCEEDED');
      await hook('', PLATFORM_KEY, { event: 'refund.processed', data: { id: rf.providerReference, status: 'processed', transaction_reference: link.reference } }).expect(200);
      expect((await prisma.paymentRefund.findUniqueOrThrow({ where: { id: rf.id } })).status).toBe('SUCCEEDED');
      expect((await order(o.id)).status).toBe('REFUNDED');
    });
  });

  // ───────────────────────── Subscriptions ─────────────────────────
  describe('subscription invoices', () => {
    it('an open invoice is paid through the platform account; the plan applies only after verification', async () => {
      const s = await register();
      const DAY = 86_400_000;
      const sub = await prisma.subscription.findFirstOrThrow({ where: { tenantId: s.tenantId } });
      const starter = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'STARTER' } });
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', planId: starter.id, interval: 'MONTHLY', currentPeriodStart: new Date(Date.now() - 15 * DAY), currentPeriodEnd: new Date(Date.now() + 15 * DAY), trialEndsAt: null } });
      const change = (await http.post('/api/v1/billing/subscription/change').set(s.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200)).body;
      expect(change.action).toBe('payment_required');
      expect((await http.get('/api/v1/billing/subscription').set(s.h)).body.paymentCollectionEnabled).toBe(true);

      const link = (await http.post(`/api/v1/billing/invoices/${change.invoice.id}/pay`).set(s.h).expect(200)).body;
      expect(fake.initialized.at(-1)!).toMatchObject({ creds: { secretKey: PLATFORM_KEY }, input: { customerEmail: s.email, amountMinor: BigInt(change.invoice.amountMinor) } });
      expect((await http.post(`/api/v1/billing/invoices/${change.invoice.id}/pay`).set(s.h).expect(200)).body.reference).toBe(link.reference);
      expect((await verify(link.reference).expect(200)).body).toMatchObject({ status: 'ABANDONED', kind: 'subscription', store: null });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true } })).plan.code).toBe('STARTER');

      fake.succeed(link.reference, BigInt(change.invoice.amountMinor), { feeMinor: 5_000n });
      await verify(link.reference).expect(200);
      expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id }, include: { plan: true } })).plan.code).toBe('PROFESSIONAL');
      const t = await txn(link.reference);
      expect(await prisma.subscriptionInvoice.findUniqueOrThrow({ where: { id: change.invoice.id } })).toMatchObject({ status: 'PAID', transactionId: t.id });
      const l = await ledger(t.id);
      expect(l.balanced).toBe(true);
      expect(l.by('platform', 'SUBSCRIPTION_REVENUE')).toBe(-BigInt(change.invoice.amountMinor));
      expect(l.rows.every((r) => r.account.tenantId === null)).toBe(true); // never mixed with the seller's sales
      await http.post(`/api/v1/billing/invoices/${change.invoice.id}/pay`).set(s.h).expect(409);
    });
  });

  // ───────────────────────── Isolation & integrity ─────────────────────────
  describe('§26 #9 isolation and ledger integrity', () => {
    it("another seller can't create links, verify, refund or list this seller's payments", async () => {
      const a = await store();
      const b = await store();
      const o = await paidOrder(a);
      await http.post(`/api/v1/orders/${o.id}/payment-link`).set(b.h).send({}).expect(404);
      await http.post(`/api/v1/orders/${o.id}/payments/verify`).set(b.h).expect(404);
      await http.post(`/api/v1/orders/${o.id}/refunds`).set(b.h).send({}).expect(404);
      const listB = (await http.get('/api/v1/payments/transactions').set(b.h).expect(200)).body;
      expect(listB.items.some((t: any) => t.reference === o.payRef)).toBe(false);
      const listA = (await http.get('/api/v1/payments/transactions?status=SUCCEEDED').set(a.h).expect(200)).body;
      expect(listA.items.map((t: any) => t.reference)).toContain(o.payRef);
      await http.post(`/api/v1/store/${b.slug}/orders/${o.reference}/pay`).send({ token: o.token, email: 'x@example.com' }).expect(404);
      expect(JSON.stringify((await http.get('/api/v1/payments/settings').set(b.h)).body)).not.toContain(a.tenantId);
    });

    it('the database refuses unbalanced journals and edits to posted entries', async () => {
      const s = await store();
      const o = await paidOrder(s);
      const t = await txn(o.payRef);
      const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { transactionId: t.id } });
      await expect(prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amountMinor: 1n } })).rejects.toThrow();
      await expect(prisma.$transaction(async (tx) => {
        await tx.ledgerEntry.create({ data: { journalId: '00000000-0000-4000-8000-000000000001', accountId: entry.accountId, direction: 'DEBIT', amountMinor: 100n, currency: 'NGN' } });
      })).rejects.toThrow(/unbalanced/i);
      await expect(app.get(LedgerService).post(prisma as never, { tenantId: s.tenantId, currency: 'NGN', lines: [{ account: 'SALES_REVENUE', amountMinor: -1n }, { account: 'GATEWAY_CLEARING', amountMinor: 2n }] })).rejects.toThrow(/unbalanced/i);
      await expect(prisma.paymentTransaction.delete({ where: { id: t.id } })).rejects.toThrow();
      await expect(prisma.paymentTransaction.update({ where: { id: t.id }, data: { sellerProceedsMinor: t.grossMinor } })).rejects.toThrow(); // split must add up
    });
  });
});
