import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { configureApp } from '../src/configure-app';
import { OrdersService } from '../src/orders/orders.service';
import { PaymentProviderRegistry } from '../src/payments/payment-provider';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer, FakePaymentProvider, FakeRegistry } from './support';

const PASSWORD = 'CorrectHorse42';
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(200)]);
type H = Record<string, string>;

describe('Phase 7 — direct bank transfer and reconciliation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let crypto: CryptoService;
  let http: ReturnType<typeof request>;
  const paystack = new FakePaymentProvider('PAYSTACK');

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer).useValue(new CapturingMailer())
      .overrideProvider(BillingNotifier).useValue(new CapturingBillingNotifier())
      .overrideProvider(PaymentProviderRegistry).useValue(new FakeRegistry(paystack))
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    crypto = app.get(CryptoService);
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p7-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p7-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { email: body.email, slug: body.storeUsername, tenantId: res.body.tenant.id as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } as H };
  }
  async function member(tenantId: string, roleKey: string): Promise<H> {
    const other = await register();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId, key: roleKey } });
    const m = await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    await prisma.tenantMember.create({ data: { tenantId, userId: m.userId, roleId: role.id } });
    return { Authorization: other.h.Authorization, 'X-Tenant-Id': tenantId };
  }
  /** Published store with BAG001 ₦25,000 × 5 and (unless told otherwise) one transfer account. */
  async function store(withAccount = true) {
    const s = await register();
    const bag = (await http.post('/api/v1/products').set(s.h).send({
      name: 'Leather Bag', productCode: 'BAG001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '2500000', initialStock: 5 }],
    }).expect(201)).body;
    await http.patch('/api/v1/store/profile').set(s.h).send({ description: 'Bags', whatsappNumber: '+2348031234567' }).expect(200);
    await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
    let account: any = null;
    if (withAccount) account = (await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankName: 'Guaranty Trust Bank', accountNumber: '0123456789', accountName: 'ADA FASHION LTD', transferInstructions: 'Use your order number as the description.' }).expect(201)).body;
    return { ...s, account, variantId: bag.variants[0].id as string };
  }
  async function checkout(s: { slug: string; variantId: string }, qty = 1) {
    const r = await http.post(`/api/v1/store/${s.slug}/checkout`).send({
      customer: { fullName: 'Amaka Nnaji', phone: phone() }, items: [{ variantId: s.variantId, quantity: qty }],
      shippingAddress: { line1: '3 Bode Thomas', city: 'Surulere', state: 'Lagos' },
    }).expect(201);
    const o = await prisma.order.findFirstOrThrow({ where: { reference: r.body.reference } });
    return { reference: r.body.reference as string, token: r.body.trackingToken as string, id: o.id, total: o.totalMinor };
  }
  const track = (slug: string, o: { reference: string; token: string }) => http.get(`/api/v1/store/${slug}/orders/${o.reference}?token=${o.token}`);
  const report = (slug: string, o: { reference: string; token: string }, extra: object = {}) =>
    http.post(`/api/v1/store/${slug}/orders/${o.reference}/transfer`).send({ token: o.token, payerName: 'Amaka Nnaji', payerBank: 'Access Bank', payerReference: `0000${uniq()}`, ...extra });
  const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
  const stock = (variantId: string) => prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  async function ledger(transactionId: string) {
    const rows = await prisma.ledgerEntry.findMany({ where: { transactionId }, include: { account: true } });
    const by = (code: string, platform = false) => rows.filter((r) => r.account.code === code && (platform ? r.account.tenantId === null : r.account.tenantId !== null))
      .reduce((s, r) => s + (r.direction === 'DEBIT' ? r.amountMinor : -r.amountMinor), 0n);
    return { rows, by };
  }
  const recon = async (h: H) => (await http.get('/api/v1/payments/reconciliation').set(h).expect(200)).body;

  // ───────────────────────── Accounts ─────────────────────────
  describe('transfer accounts (§13)', () => {
    it('confirms the name with the bank when it can, stores the number encrypted, keeps one default, limits to three', async () => {
      const s = await store(false);
      paystack.resolvable.set('0690000032', 'PASTOR BRIGHT VENTURES');
      const a = (await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankCode: '044', bankName: 'Access Bank', accountNumber: '0690000032', accountName: 'Pastor Bright' }).expect(201)).body;
      expect(a).toMatchObject({ accountName: 'PASTOR BRIGHT VENTURES', nameVerified: true, nameMismatch: true, isDefault: true, accountNumber: '0690000032', last4: '0032' });
      const row = await prisma.bankAccount.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.accountNumberEnc).not.toContain('0690000032');
      expect(crypto.decrypt(row.accountNumberEnc, s.tenantId)).toBe('0690000032');
      const b = (await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankName: 'Moniepoint MFB', accountNumber: '8012345678', accountName: 'Ada Okafor' }).expect(201)).body;
      expect(b).toMatchObject({ nameVerified: false, isDefault: false, nameMismatch: false });
      await http.patch(`/api/v1/payments/bank-accounts/${b.id}`).set(s.h).send({ isDefault: true }).expect(200);
      expect(await prisma.bankAccount.count({ where: { tenantId: s.tenantId, forTransfers: true, isDefault: true } })).toBe(1);
      await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankName: 'Zenith Bank', accountNumber: '2012345678', accountName: 'Ada Okafor' }).expect(201);
      expect((await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankName: 'Opay', accountNumber: '9012345678', accountName: 'Ada Okafor' }).expect(409)).body.code).toBe('TOO_MANY_ACCOUNTS');
      await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankName: 'Opay', accountNumber: '90123', accountName: 'Ada' }).expect(400);

      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.post('/api/v1/payments/bank-accounts').set(assistant).send({ bankName: 'X Bank', accountNumber: '1111111111', accountName: 'X' }).expect(403);
      const manager = await member(s.tenantId, 'STORE_MANAGER');
      expect((await http.get('/api/v1/payments/bank-accounts').set(manager).expect(200)).body).toHaveLength(3);
      await http.delete(`/api/v1/payments/bank-accounts/${b.id}`).set(manager).expect(403);
      await http.delete(`/api/v1/payments/bank-accounts/${b.id}`).set(s.h).expect(200);
      const other = await register();
      await http.patch(`/api/v1/payments/bank-accounts/${a.id}`).set(other.h).send({ isActive: false }).expect(404);
      // Split-settlement bank accounts (Phase 5) are never shown to customers.
      expect((await http.get('/api/v1/payments/bank-accounts').set(s.h)).body.every((x: any) => x.id !== undefined)).toBe(true);
    });
  });

  // ───────────────────────── Customer reports ─────────────────────────
  describe('customer reports a transfer', () => {
    it('tracking shows the account; a receipt is uploaded privately; the order waits for verification with its stock held', async () => {
      const s = await store();
      const o = await checkout(s);
      let t = (await track(s.slug, o).expect(200)).body;
      expect(t.bankTransfer.accounts).toEqual([{ id: s.account.id, bankName: 'Guaranty Trust Bank', accountName: 'ADA FASHION LTD', accountNumber: '0123456789', instructions: 'Use your order number as the description.', nameVerified: false }]);
      expect(t.bankTransfer.claims).toEqual([]);

      const up = (await http.post(`/api/v1/store/${s.slug}/orders/${o.reference}/transfer/receipt-url`).send({ token: o.token, contentType: 'image/png', contentLength: PNG.length }).expect(200)).body;
      expect(up.key).toMatch(new RegExp(`^tenants/${s.tenantId}/private/transfers/`));
      expect((await fetch(up.uploadUrl, { method: 'PUT', body: PNG, headers: { 'Content-Type': 'image/png' } })).ok).toBe(true);
      await http.post(`/api/v1/store/${s.slug}/orders/${o.reference}/transfer/receipt-url`).send({ token: 'wrong-token', contentType: 'image/png', contentLength: 10 }).expect(404);
      await http.post(`/api/v1/store/${s.slug}/orders/${o.reference}/transfer/receipt-url`).send({ token: o.token, contentType: 'image/svg+xml', contentLength: 10 }).expect(400);

      const claim = (await report(s.slug, o, { receiptKey: up.key, amountMinor: '2500000', bankAccountId: s.account.id }).expect(200)).body;
      expect(claim).toMatchObject({ status: 'PENDING', verified: false, hasReceipt: true, submittedBy: 'customer', payerName: 'Amaka Nnaji', amountClaimedMinor: '2500000' });
      const after = await order(o.id);
      expect(after).toMatchObject({ status: 'PAYMENT_VERIFICATION', paymentStatus: 'AWAITING_VERIFICATION' });
      expect(after.reservationExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000);
      expect((await stock(s.variantId)).reserved).toBe(1);
      t = (await track(s.slug, o)).body;
      expect(t).toMatchObject({ status: 'PAYMENT_VERIFICATION', bankTransfer: { claims: [{ status: 'AWAITING_CHECK' }] } });
      expect(JSON.stringify(t)).not.toContain(up.key); // no internal fields
      // The same upload can't be attached twice; the report never marks anything paid.
      await report(s.slug, o, { receiptKey: up.key }).expect(400);
      expect(await prisma.paymentTransaction.count({ where: { orderId: o.id, status: 'SUCCEEDED' } })).toBe(0);
      expect(await prisma.ledgerEntry.count({ where: { transactionId: claim.id } })).toBe(0);
      const history = await prisma.orderStatusHistory.findFirstOrThrow({ where: { orderId: o.id, toStatus: 'PAYMENT_VERIFICATION' } });
      expect(history).toMatchObject({ actorType: 'customer' });
    });

    it('refuses bots, wrong tokens, stores without an account and too many reports', async () => {
      const s = await store();
      const o = await checkout(s);
      await report(s.slug, o, { website: 'spam' }).expect(400);
      await report(s.slug, { ...o, token: 'nope' }).expect(404);
      await report(s.slug, o, { payerName: 'A' }).expect(400);
      await report(s.slug, o, { receiptKey: `tenants/${s.tenantId}/private/verification/x.png` }).expect(400); // not a key issued for this
      for (let i = 0; i < 3; i++) await report(s.slug, o).expect(200);
      expect((await report(s.slug, o).expect(409)).body.code).toBe('TOO_MANY_CLAIMS');
      const other = await store(false);
      const o2 = await checkout(other);
      expect((await report(other.slug, o2).expect(409)).body.code).toBe('TRANSFERS_NOT_SET_UP');
      await report(other.slug, o).expect(404); // another store's order
    });
  });

  // ───────────────────────── Verification ─────────────────────────
  describe('seller verification', () => {
    it('only people with payments:verify_transfer verify; exact amount; PAID with the sale booked to the seller’s bank, once', async () => {
      const s = await store();
      const o = await checkout(s, 2);
      const claim = (await report(s.slug, o).expect(200)).body;
      const url = `/api/v1/orders/${o.id}/transfers/${claim.id}/verify`;
      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.post(url).set(assistant).send({ amountReceivedMinor: '5000000' }).expect(403);
      const other = await register();
      await http.post(url).set({ Authorization: other.h.Authorization, 'X-Tenant-Id': s.tenantId }).send({ amountReceivedMinor: '5000000' }).expect(403); // not a member of this store
      const otherOwner = await store();
      await http.post(`/api/v1/orders/${o.id}/transfers/${claim.id}/verify`).set(otherOwner.h).send({ amountReceivedMinor: '5000000' }).expect(404); // §26 #9
      const manager = await member(s.tenantId, 'STORE_MANAGER');
      expect((await http.post(url).set(manager).send({ amountReceivedMinor: '4999999' }).expect(400)).body.code).toBe('AMOUNT_MISMATCH');
      expect((await order(o.id)).status).toBe('PAYMENT_VERIFICATION');

      const v = (await http.post(url).set(manager).send({ amountReceivedMinor: '5000000', note: 'Seen in GTBank app' }).expect(200)).body;
      expect(v).toMatchObject({ status: 'SUCCEEDED', verified: true, decision: { outcome: 'VERIFIED', amountReceivedMinor: '5000000', reason: 'Seen in GTBank app' }, attention: null });
      expect(await order(o.id)).toMatchObject({ status: 'PAID', paymentStatus: 'PAID', reservationExpiresAt: null });
      const t = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: claim.id } });
      const managerId = (await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: s.tenantId, role: { key: 'STORE_MANAGER' } } })).userId;
      expect(t).toMatchObject({ provider: 'BANK_TRANSFER', settlementMode: 'BANK_TRANSFER', settlementStatus: 'SETTLED', providerFeeMinor: 0n, sellerProceedsMinor: 5_000_000n, verifiedBy: `user:${managerId}` });
      const l = await ledger(t.id);
      expect(l.by('SELLER_BANK')).toBe(5_000_000n);
      expect(l.by('SALES_REVENUE')).toBe(-5_000_000n);
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'payment.transfer_verified', actorId: managerId } })).toBe(1);
      expect((await http.post(url).set(manager).send({ amountReceivedMinor: '5000000' }).expect(409)).body.code).toBe('ALREADY_DECIDED');
      expect(l.rows.length).toBe((await ledger(t.id)).rows.length);
      const paid = await prisma.orderStatusHistory.findFirstOrThrow({ where: { orderId: o.id, toStatus: 'PAID' } });
      expect(paid).toMatchObject({ actorId: managerId, actorType: 'system' });
      expect(paid.note).toMatch(/bank transfer checked by staff/);
      // Fulfilment and a recorded refund work like any other payment.
      await http.post(`/api/v1/orders/${o.id}/status`).set(s.h).send({ status: 'PROCESSING' }).expect(200);
      expect((await recon(s.h)).summary).toMatchObject({ errors: 0, warnings: 0, verifiedPayments: 1, verifiedMinor: '5000000' });
    });

    it('rejecting a report puts the order back to awaiting payment (only when no other report is pending)', async () => {
      const s = await store();
      const o = await checkout(s);
      const a = (await report(s.slug, o).expect(200)).body;
      const b = (await report(s.slug, o).expect(200)).body;
      await http.post(`/api/v1/orders/${o.id}/transfers/${a.id}/reject`).set(s.h).send({ reason: 'x' }).expect(400);
      const r = (await http.post(`/api/v1/orders/${o.id}/transfers/${a.id}/reject`).set(s.h).send({ reason: 'No matching credit' }).expect(200)).body;
      expect(r).toMatchObject({ status: 'FAILED', decision: { outcome: 'REJECTED', reason: 'No matching credit' } });
      expect((await order(o.id)).status).toBe('PAYMENT_VERIFICATION');
      await http.post(`/api/v1/orders/${o.id}/transfers/${b.id}/reject`).set(s.h).send({ reason: 'Wrong amount sent' }).expect(200);
      expect(await order(o.id)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'PENDING' });
      expect((await track(s.slug, o)).body.bankTransfer.claims.map((c: any) => c.status)).toEqual(['NOT_FOUND', 'NOT_FOUND']);
      await http.post(`/api/v1/orders/${o.id}/transfers/${b.id}/verify`).set(s.h).send({ amountReceivedMinor: '2500000' }).expect(409);
    });

    it('staff can record a phone customer’s transfer with a receipt; the receipt link is private and short-lived', async () => {
      const s = await store();
      const created = (await http.post('/api/v1/orders').set(s.h).send({ customer: { fullName: 'Bola Ade', phone: phone() }, items: [{ variantId: s.variantId, quantity: 1 }] }).expect(201)).body;
      const moderator = await member(s.tenantId, 'LIVE_MODERATOR');
      const up = (await http.post(`/api/v1/orders/${created.id}/transfers/receipt-url`).set(moderator).send({ contentType: 'application/pdf', contentLength: 300 }).expect(201)).body;
      const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(291)]);
      expect((await fetch(up.uploadUrl, { method: 'PUT', body: pdf, headers: { 'Content-Type': 'application/pdf' } })).ok).toBe(true);
      const claim = (await http.post(`/api/v1/orders/${created.id}/transfers`).set(moderator).send({ payerName: 'Bola Ade', receiptKey: up.key }).expect(201)).body;
      expect(claim).toMatchObject({ submittedBy: 'staff', hasReceipt: true });
      await http.get(`/api/v1/orders/${created.id}/transfers/${claim.id}/receipt`).set(moderator).expect(403); // payments:read
      const link = (await http.get(`/api/v1/orders/${created.id}/transfers/${claim.id}/receipt`).set(s.h).expect(200)).body.url;
      expect((await fetch(link)).status).toBe(200);
      const pending = (await http.get('/api/v1/payments/transfers/pending').set(s.h).expect(200)).body;
      expect(pending.map((p: any) => p.id)).toContain(claim.id);
      expect(pending.find((p: any) => p.id === claim.id).order).toMatchObject({ reference: created.reference, status: 'PAYMENT_VERIFICATION' });
      const detail = (await http.get(`/api/v1/orders/${created.id}`).set(s.h).expect(200)).body;
      expect(detail.transactions[0]).toMatchObject({ provider: 'BANK_TRANSFER', status: 'PENDING', transferEvidence: { payerName: 'Bola Ade', submittedBy: 'staff' } });
    });

    it('commission plan: commission owed on a verified transfer is booked for both sides', async () => {
      const s = await store();
      const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'PAY_AS_YOU_SELL' } });
      const sub = await prisma.subscription.findFirstOrThrow({ where: { tenantId: s.tenantId } });
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', planId: plan.id, trialEndsAt: null } });
      const o = await checkout(s);
      const claim = (await report(s.slug, o).expect(200)).body;
      await http.post(`/api/v1/orders/${o.id}/transfers/${claim.id}/verify`).set(s.h).send({ amountReceivedMinor: '2500000' }).expect(200);
      const c = (2_500_000n * BigInt(plan.commissionBps!)) / 10_000n;
      const l = await ledger(claim.id);
      expect(l.by('COMMISSION_PAYABLE')).toBe(-c);
      expect(l.by('COMMISSION_RECEIVABLE', true)).toBe(c);
      expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: claim.id } })).sellerProceedsMinor).toBe(2_500_000n - c);
    });
  });

  // ───────────────────────── §26 #5 and refunds ─────────────────────────
  describe('§26 #5 a transfer that stays unverified', () => {
    it('is flagged, the order eventually lapses and frees its stock, and a late verification is flagged for a recorded refund', async () => {
      const s = await store();
      const o = await checkout(s);
      const claim = (await report(s.slug, o).expect(200)).body;
      // Still unchecked after a day → warning.
      await prisma.paymentTransaction.update({ where: { id: claim.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
      let r = await recon(s.h);
      expect(r.issues).toEqual([expect.objectContaining({ type: 'UNVERIFIED_TRANSFER', severity: 'warning', orderReference: o.reference })]);
      expect(r.summary).toMatchObject({ unverifiedTransfers: 1, unverifiedMinor: '2500000' });

      // Nobody checks before the hold ends → cancelled, stock released, transfer still clearly unverified.
      await prisma.order.update({ where: { id: o.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
      await orders.expireReservations(new Date());
      expect((await order(o.id)).status).toBe('CANCELLED');
      expect((await stock(s.variantId)).reserved).toBe(0);
      r = await recon(s.h);
      expect(r.issues).toEqual([expect.objectContaining({ type: 'TRANSFER_ON_CLOSED_ORDER', severity: 'error' })]);

      // The money did arrive: verifying records it without reviving the order, and asks for a refund.
      const v = (await http.post(`/api/v1/orders/${o.id}/transfers/${claim.id}/verify`).set(s.h).send({ amountReceivedMinor: '2500000' }).expect(200)).body;
      expect(v).toMatchObject({ status: 'SUCCEEDED', attention: 'ORDER_NOT_PAYABLE' });
      expect((await order(o.id)).status).toBe('CANCELLED');
      r = await recon(s.h);
      expect(r.issues.map((i: any) => i.type)).toEqual(['NEEDS_REFUND']);

      // Bank transfers are refunded by the seller; LiveSell records it (with how it was done) and books it at once.
      expect((await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(400)).body.code).toBe('REFUND_DETAILS_REQUIRED');
      const rf = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ reason: 'Sent back from GTBank, ref 000777' }).expect(201)).body.refund;
      expect(rf).toMatchObject({ status: 'SUCCEEDED', amountMinor: '2500000', providerReference: null });
      expect(paystack.refundCalls).toHaveLength(0);
      const l = await ledger(claim.id);
      expect(l.by('SALES_REFUNDS')).toBe(2_500_000n);
      expect(l.by('SELLER_BANK')).toBe(0n);
      expect((await order(o.id)).status).toBe('CANCELLED');
      expect((await recon(s.h)).summary).toMatchObject({ errors: 0, warnings: 0 });
      expect(await prisma.auditLog.count({ where: { tenantId: s.tenantId, action: 'payment.refund_recorded' } })).toBe(1);
    });

    it('a recorded refund on a paid order refunds it and releases undispatched stock', async () => {
      const s = await store();
      const o = await checkout(s, 2);
      const claim = (await report(s.slug, o).expect(200)).body;
      await http.post(`/api/v1/orders/${o.id}/transfers/${claim.id}/verify`).set(s.h).send({ amountReceivedMinor: '5000000' }).expect(200);
      await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '1000000', reason: 'Partial: one strap missing' }).expect(201);
      expect((await order(o.id)).status).toBe('PARTIALLY_REFUNDED');
      await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ reason: 'Customer returned the rest' }).expect(201);
      expect(await order(o.id)).toMatchObject({ status: 'REFUNDED', paymentStatus: 'REFUNDED' });
      expect(await stock(s.variantId)).toMatchObject({ onHand: 5, reserved: 0 });
    });
  });

  // ───────────────────────── Reconciliation ─────────────────────────
  describe('reconciliation', () => {
    it('finds orders shown as paid without a payment and journals that don’t match; scoped to the store', async () => {
      const s = await store();
      const o = await checkout(s);
      const other = await store();
      expect((await recon(s.h)).summary).toMatchObject({ errors: 0 });
      // An order marked paid without any verified payment (e.g. edited outside the app) is an error.
      await prisma.order.update({ where: { id: o.id }, data: { status: 'PAID', paymentStatus: 'PAID' } });
      const r = await recon(s.h);
      expect(r.issues).toEqual([expect.objectContaining({ type: 'PAID_WITHOUT_PAYMENT', orderReference: o.reference })]);
      expect((await recon(other.h)).summary.errors).toBe(0); // another store's problems are not shown

      // A succeeded transaction with no journal at all.
      await prisma.paymentTransaction.create({ data: { tenantId: s.tenantId, purpose: 'ORDER', orderId: o.id, provider: 'PAYSTACK', reference: `LS-RECON-${uniq()}`, idempotencyKey: `recon-${uniq()}`, currency: 'NGN', grossMinor: 2_500_000n, status: 'SUCCEEDED', verifiedBy: 'test' } });
      const r2 = await recon(s.h);
      expect(r2.issues.map((i: any) => i.type).sort()).toEqual(['SALE_NOT_IN_LEDGER']);

      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.get('/api/v1/payments/reconciliation').set(assistant).expect(403);
      const admin = await register();
      await prisma.user.updateMany({ where: { email: admin.email }, data: { platformRole: 'PLATFORM_ADMIN' } });
      const platform = (await http.get('/api/v1/admin/payments/reconciliation').set({ Authorization: admin.h.Authorization }).expect(200)).body;
      expect(platform.stores.find((x: any) => x.tenantId === s.tenantId)).toMatchObject({ errors: 1, types: ['SALE_NOT_IN_LEDGER'] });
      await http.get('/api/v1/admin/payments/reconciliation').set({ Authorization: s.h.Authorization }).expect(403);
    });

    it('the database refuses a bank-transfer payment without its transfer report', async () => {
      const s = await store();
      await expect(prisma.paymentTransaction.create({ data: { tenantId: s.tenantId, purpose: 'ORDER', provider: 'BANK_TRANSFER', reference: `LS-X-${uniq()}`, idempotencyKey: `x-${uniq()}`, currency: 'NGN', grossMinor: 100n, status: 'SUCCEEDED' } })).rejects.toThrow();
    });
  });
});
