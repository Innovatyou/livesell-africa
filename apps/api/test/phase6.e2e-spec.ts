import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { CryptoService } from '../src/common/crypto/crypto.service';
import { configureApp } from '../src/configure-app';
import { PaymentProviderRegistry } from '../src/payments/payment-provider';
import { PaymentsService } from '../src/payments/payments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer, FakePaymentProvider, FakeRegistry, signBachsWebhook } from './support';

const PASSWORD = 'CorrectHorse42';
const FLW_KEY = 'FLWSECK' + '_TEST-sellerflutterwave0000000000-X';
const FLW_PK = 'FLWPUBK_TEST-sellerflutterwave0000000000-X';
const FLW_HASH = 'seller-flutterwave-secret-hash';
const BACHS_KEY = 'sk_sandbox_seller01_ABCDEFGHIJKLMNOPQRSTUV';
const BACHS_SECRET = 'whsec_seller_bachs_signing_secret';
const PAYSTACK_KEY = 'sk_test_sellerownkey0123456789';
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
type H = Record<string, string>;

describe('Phase 6 — Flutterwave and Bachs behind the same payment port', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let crypto: CryptoService;
  let http: ReturnType<typeof request>;
  const paystack = new FakePaymentProvider('PAYSTACK');
  const flw = new FakePaymentProvider('FLUTTERWAVE');
  const bachs = new FakePaymentProvider('BACHS');
  for (const [f, k] of [[paystack, PAYSTACK_KEY], [flw, FLW_KEY], [bachs, BACHS_KEY]] as const) f.validKeys.add(k);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer).useValue(new CapturingMailer())
      .overrideProvider(BillingNotifier).useValue(new CapturingBillingNotifier())
      .overrideProvider(PaymentProviderRegistry).useValue(new FakeRegistry(paystack, flw, bachs))
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);
    crypto = app.get(CryptoService);
    http = request(app.getHttpServer());
    await enable(['PAYSTACK', 'FLUTTERWAVE', 'BACHS'], true);
  });
  afterAll(async () => {
    await enable(['PAYSTACK', 'FLUTTERWAVE', 'BACHS'], false); // seeded default
    await app.close();
  });
  beforeEach(() => { for (const f of [paystack, flw, bachs]) { f.down = false; f.refundDecline = null; } });

  const enable = (codes: string[], isEnabled: boolean) => prisma.paymentProvider.updateMany({ where: { code: { in: codes as never } }, data: { isEnabled } });

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p6-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p6-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { slug: body.storeUsername, tenantId: res.body.tenant.id as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } as H };
  }
  async function store() {
    const s = await register();
    const bag = (await http.post('/api/v1/products').set(s.h).send({
      name: 'Leather Bag', productCode: 'BAG001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '2500000', initialStock: 5 }],
    }).expect(201)).body;
    await http.patch('/api/v1/store/profile').set(s.h).send({ description: 'Bags', whatsappNumber: '+2348031234567' }).expect(200);
    await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
    return { ...s, variantId: bag.variants[0].id as string };
  }
  const connect = (h: H, provider: string, body: object) => http.put(`/api/v1/payments/settings/${provider}/direct`).set(h).send(body);
  async function checkout(s: { slug: string; variantId: string }, qty = 1) {
    const r = await http.post(`/api/v1/store/${s.slug}/checkout`).send({
      customer: { fullName: 'Amaka Nnaji', phone: phone() }, items: [{ variantId: s.variantId, quantity: qty }],
      shippingAddress: { line1: '3 Bode Thomas', city: 'Surulere', state: 'Lagos' },
    }).expect(201);
    const o = await prisma.order.findFirstOrThrow({ where: { reference: r.body.reference } });
    return { reference: r.body.reference as string, token: r.body.trackingToken as string, id: o.id, total: o.totalMinor };
  }
  const pay = (slug: string, o: { reference: string; token: string }) => http.post(`/api/v1/store/${slug}/orders/${o.reference}/pay`).send({ token: o.token, email: 'amaka@example.com' });
  const verify = (reference: string) => http.post('/api/v1/payments/verify').send({ reference });
  const order = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
  const txn = (reference: string) => prisma.paymentTransaction.findUniqueOrThrow({ where: { reference } });
  async function balanced(transactionId: string) {
    const rows = await prisma.ledgerEntry.findMany({ where: { transactionId } });
    const journals = [...new Set(rows.map((r) => r.journalId))];
    return rows.length > 0 && journals.every((j) => rows.filter((r) => r.journalId === j).reduce((s, r) => s + (r.direction === 'DEBIT' ? r.amountMinor : -r.amountMinor), 0n) === 0n);
  }
  async function paid(s: { slug: string; variantId: string }, f: FakePaymentProvider) {
    const o = await checkout(s);
    const link = (await pay(s.slug, o).expect(200)).body;
    expect(link.provider).toBe(f.code);
    f.succeed(link.reference, o.total);
    expect((await verify(link.reference).expect(200)).body.status).toBe('SUCCEEDED');
    return { ...o, payRef: link.reference as string };
  }

  // ───────────────────────── Connecting providers ─────────────────────────
  describe('settings', () => {
    it('lists every integrated provider; keys are checked per provider and stored encrypted with the webhook secret', async () => {
      const s = await store();
      let list = (await http.get('/api/v1/payments/settings').set(s.h).expect(200)).body;
      expect(list.providers.map((p: any) => p.provider.code)).toEqual(['PAYSTACK', 'FLUTTERWAVE', 'BACHS']);
      expect(list.providers.find((p: any) => p.provider.code === 'BACHS')).toMatchObject({ splitAvailable: false, capabilities: { multipleRefunds: false, webhookSecret: 'separate' }, account: null });
      expect(list.providers.find((p: any) => p.provider.code === 'FLUTTERWAVE')).toMatchObject({ splitAvailable: true, capabilities: { minRefundMinor: '10000' } });
      expect(list.defaultProvider).toBeNull();

      expect((await connect(s.h, 'flutterwave', { secretKey: PAYSTACK_KEY }).expect(400)).body.code).toBe('INVALID_KEY_FORMAT');
      expect((await connect(s.h, 'flutterwave', { secretKey: FLW_KEY, publicKey: 'FLWPUBK-livepubliclivepubli000-X' }).expect(400)).body.code).toBe('KEY_MODE_MISMATCH');
      expect((await connect(s.h, 'flutterwave', { secretKey: 'FLWSECK' + '_TEST-notacceptedbyflutterwave000-X' }).expect(422)).body.code).toBe('INVALID_KEY');
      expect((await connect(s.h, 'paystack', { secretKey: PAYSTACK_KEY, publicKey: 'pk_test_x', webhookSecret: 'some-webhook-secret-value' }).expect(400)).body.code).toBe('INVALID_KEY_FORMAT');
      await http.put('/api/v1/payments/settings/stripe/direct').set(s.h).send({ secretKey: 'x' }).expect(404);

      const r = (await connect(s.h, 'flutterwave', { secretKey: FLW_KEY, publicKey: FLW_PK, webhookSecret: FLW_HASH }).expect(200)).body;
      expect(r.account).toMatchObject({ mode: 'DIRECT', isDefault: true, testMode: true, hasSecretKey: true, hasWebhookSecret: true, publicKey: FLW_PK });
      expect(r.account.webhookUrl).toMatch(new RegExp(`/api/v1/payments/flutterwave/webhook/${r.account.id}$`));
      expect(JSON.stringify(r)).not.toContain(FLW_KEY);
      expect(JSON.stringify(r)).not.toContain(FLW_HASH);
      const row = await prisma.sellerPaymentAccount.findUniqueOrThrow({ where: { id: r.account.id } });
      expect(JSON.parse(crypto.decrypt(row.credentialsEnc!, s.tenantId))).toEqual({ secretKey: FLW_KEY, webhookSecret: FLW_HASH });

      // Rotating the API key keeps the saved webhook secret.
      flw.validKeys.add('FLWSECK' + '_TEST-rotatedflutterwavekey0000-X');
      await connect(s.h, 'flutterwave', { secretKey: 'FLWSECK' + '_TEST-rotatedflutterwavekey0000-X' }).expect(200);
      const rotated = await prisma.sellerPaymentAccount.findUniqueOrThrow({ where: { id: r.account.id } });
      expect(JSON.parse(crypto.decrypt(rotated.credentialsEnc!, s.tenantId))).toEqual({ secretKey: 'FLWSECK' + '_TEST-rotatedflutterwavekey0000-X', webhookSecret: FLW_HASH });

      const b = (await connect(s.h, 'bachs', { secretKey: BACHS_KEY }).expect(200)).body;
      expect(b.account).toMatchObject({ isDefault: false, hasWebhookSecret: false, publicKey: null });
      list = (await http.get('/api/v1/payments/settings').set(s.h).expect(200)).body;
      expect(list.defaultProvider).toBe('FLUTTERWAVE');
      expect(JSON.stringify(list)).not.toMatch(/FLWSECK|sk_sandbox_seller/);
      list = (await http.post('/api/v1/payments/settings/bachs/default').set(s.h).expect(200)).body;
      expect(list.defaultProvider).toBe('BACHS');
      expect(await prisma.sellerPaymentAccount.count({ where: { tenantId: s.tenantId, isDefault: true } })).toBe(1);
      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.post('/api/v1/payments/settings/flutterwave/default').set(assistant).expect(403);
    });

    it('split settlement: Flutterwave subaccount via the platform key; Bachs refuses (Connect not enabled)', async () => {
      const s = await store();
      expect((await http.put('/api/v1/payments/settings/bachs/split').set(s.h).send({ bankCode: '044', accountNumber: '0690000032' }).expect(503)).body.code).toBe('SPLIT_NOT_AVAILABLE');
      expect((await http.get('/api/v1/payments/banks?provider=bachs').set(s.h).expect(200)).body).toEqual([]);
      expect((await http.get('/api/v1/payments/banks?provider=flutterwave').set(s.h).expect(200)).body.length).toBeGreaterThan(0);
      flw.resolvable.set('0690000032', 'PASTOR BRIGHT');
      const r = (await http.put('/api/v1/payments/settings/flutterwave/split').set(s.h).send({ bankCode: '044', accountNumber: '0690000032' }).expect(200)).body;
      expect(r.account).toMatchObject({ mode: 'SPLIT', subaccountCode: expect.stringMatching(/^ACCT_fake/), bankAccount: { accountName: 'PASTOR BRIGHT', last4: '0032' }, webhookUrl: null });
    });

    it('a provider switched off by the platform is skipped; the next connected one takes over', async () => {
      const s = await store();
      await connect(s.h, 'bachs', { secretKey: BACHS_KEY }).expect(200);
      await connect(s.h, 'flutterwave', { secretKey: FLW_KEY }).expect(200);
      const o = await checkout(s);
      expect((await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${o.token}`)).body.onlinePayment).toMatchObject({ online: true, provider: 'BACHS', providerName: 'Bachs' });
      await enable(['BACHS'], false);
      try {
        expect((await http.get(`/api/v1/store/${s.slug}/orders/${o.reference}?token=${o.token}`)).body.onlinePayment).toMatchObject({ provider: 'FLUTTERWAVE' });
        expect((await pay(s.slug, o).expect(200)).body.provider).toBe('FLUTTERWAVE');
      } finally {
        await enable(['BACHS'], true);
      }
    });
  });

  async function member(tenantId: string, roleKey: string): Promise<H> {
    const other = await register();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId, key: roleKey } });
    const m = await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    await prisma.tenantMember.create({ data: { tenantId, userId: m.userId, roleId: role.id } });
    return { Authorization: other.h.Authorization, 'X-Tenant-Id': tenantId };
  }

  // ───────────────────────── Paying ─────────────────────────
  describe('payments', () => {
    it('Flutterwave: link, verify by our reference, PAID with a balanced ledger; refunds use the Flutterwave transaction id and respect the ₦100 minimum', async () => {
      const s = await store();
      await connect(s.h, 'flutterwave', { secretKey: FLW_KEY }).expect(200);
      const o = await checkout(s, 2);
      const link = (await pay(s.slug, o).expect(200)).body;
      expect(link.checkoutUrl).toContain('checkout.flutterwave.test');
      expect(flw.initialized.at(-1)!).toMatchObject({ creds: { secretKey: FLW_KEY }, input: { amountMinor: 5_000_000n, customerName: 'Amaka Nnaji', customerEmail: 'amaka@example.com' } });
      flw.succeed(link.reference, 5_000_000n, { providerReference: '908790', feeMinor: 70_000n });
      await verify(link.reference).expect(200);
      expect(await order(o.id)).toMatchObject({ status: 'PAID' });
      const t = await txn(link.reference);
      expect(t).toMatchObject({ provider: 'FLUTTERWAVE', providerReference: '908790', providerFeeMinor: 70_000n, verifiedBy: 'flutterwave:return', sellerProceedsMinor: 4_930_000n });
      expect(await balanced(t.id)).toBe(true);

      expect((await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '5000' }).expect(400)).body.code).toBe('REFUND_TOO_SMALL');
      const rf = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '1000000' }).expect(201)).body.refund;
      expect(flw.refundCalls.at(-1)).toMatchObject({ reference: link.reference, providerReference: '908790', amountMinor: 1_000_000n, refundId: rf.id });
      // Flutterwave allows more than one refund on a payment.
      await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '1000000' }).expect(201);
      flw.refunds.forEach((_v, k) => flw.refunds.set(k, 'SUCCEEDED'));
      await payments.reconcile(new Date());
      expect(await order(o.id)).toMatchObject({ status: 'PARTIALLY_REFUNDED' });
      expect(await balanced(t.id)).toBe(true);
    });

    it('Bachs: the checkout id is stored and used to verify; one refund per payment', async () => {
      const s = await store();
      await connect(s.h, 'bachs', { secretKey: BACHS_KEY }).expect(200);
      const o = await paid(s, bachs);
      const t = await txn(o.payRef);
      expect(t.providerCheckoutId).toBe(`chk_${o.payRef.replace(/[^A-Za-z0-9]/g, '')}`);
      expect(bachs.verifyContexts.filter((c) => c.reference === o.payRef).every((c) => c.providerCheckoutId === t.providerCheckoutId)).toBe(true);
      expect(t).toMatchObject({ provider: 'BACHS', verifiedBy: 'bachs:return', status: 'SUCCEEDED' });
      expect(await balanced(t.id)).toBe(true);

      bachs.refundDecline = 'Refunds are not supported for this charge';
      expect((await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '500000' }).expect(422)).body.message).toMatch(/^Bachs declined the refund/);
      bachs.refundDecline = null;
      const first = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '500000' }).expect(201)).body.refund;
      expect((await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({ amountMinor: '500000' }).expect(409)).body.code).toBe('ONE_REFUND_ONLY');
      // A refund the provider fails frees the payment for a new one.
      bachs.refunds.set(first.providerReference, 'FAILED');
      await payments.reconcile(new Date());
      const second = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(201)).body.refund;
      expect(second.amountMinor).toBe('2500000');
      bachs.refunds.set(second.providerReference, 'SUCCEEDED');
      await payments.reconcile(new Date());
      expect(await order(o.id)).toMatchObject({ status: 'REFUNDED' });
    });

    it('Flutterwave split on a commission plan: flat platform charge to Flutterwave, both books balanced', async () => {
      const s = await store();
      flw.resolvable.set('0690000033', 'ZEN DAYA');
      await http.put('/api/v1/payments/settings/flutterwave/split').set(s.h).send({ bankCode: '044', accountNumber: '0690000033' }).expect(200);
      const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'PAY_AS_YOU_SELL' } });
      const sub = await prisma.subscription.findFirstOrThrow({ where: { tenantId: s.tenantId } });
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', planId: plan.id, trialEndsAt: null } });
      const o = await checkout(s, 2);
      const link = (await pay(s.slug, o).expect(200)).body;
      const init = flw.initialized.at(-1)!;
      const expected = (5_000_000n * BigInt(plan.commissionBps!)) / 10_000n;
      expect(init.creds.secretKey).toBe(process.env.FLUTTERWAVE_SECRET_KEY);
      expect(init.input.split).toEqual({ subaccountCode: expect.stringMatching(/^ACCT_fake/), platformChargeMinor: expected });
      flw.succeed(link.reference, 5_000_000n, { feeMinor: 70_000n });
      await verify(link.reference).expect(200);
      const t = await txn(link.reference);
      expect(t).toMatchObject({ settlementMode: 'SPLIT', platformCommissionMinor: expected, sellerProceedsMinor: 5_000_000n - expected - 70_000n });
      const rows = await prisma.ledgerEntry.findMany({ where: { transactionId: t.id }, include: { account: true } });
      expect(rows.some((r) => r.account.tenantId === null && r.account.code === 'COMMISSION_REVENUE' && r.amountMinor === expected)).toBe(true);
      expect(await balanced(t.id)).toBe(true);
    });

    it('payments started before a Phase 5 account upgrade still work (bare encrypted Paystack key)', async () => {
      const s = await store();
      const provider = await prisma.paymentProvider.findUniqueOrThrow({ where: { code: 'PAYSTACK' } });
      await prisma.sellerPaymentAccount.create({ data: { tenantId: s.tenantId, providerId: provider.id, settlementMode: 'DIRECT', credentialsEnc: crypto.encrypt(PAYSTACK_KEY, s.tenantId), publicKey: 'pk_test_legacy00000000', isDefault: true } });
      const o = await paid(s, paystack);
      expect((await txn(o.payRef)).verifiedBy).toBe('paystack:return');
      expect(paystack.initialized.at(-1)!.creds.secretKey).toBe(PAYSTACK_KEY);
    });
  });

  // ───────────────────────── Webhooks ─────────────────────────
  describe('webhooks (§26 #3)', () => {
    const flwHook = (path: string, hash: string | null, payload: unknown) => {
      const req = http.post(`/api/v1/payments/flutterwave/webhook${path}`).set('Content-Type', 'application/json');
      if (hash) req.set('verif-hash', hash);
      return req.send(JSON.stringify(payload));
    };
    const bachsHook = (path: string, secret: string, payload: unknown, at?: number) => {
      const { body, header } = signBachsWebhook(secret, payload, at);
      return http.post(`/api/v1/payments/bachs/webhook${path}`).set('Content-Type', 'application/json').set('X-Bachs-Signature-V2', header).send(body);
    };

    it('Flutterwave: verif-hash checked per account; the event only triggers a verify; duplicates ignored', async () => {
      const s = await store();
      const acc = (await connect(s.h, 'flutterwave', { secretKey: FLW_KEY, webhookSecret: FLW_HASH }).expect(200)).body.account;
      const o = await checkout(s);
      const link = (await pay(s.slug, o).expect(200)).body;
      const evt = { event: 'charge.completed', data: { id: 900_000 + seq++, tx_ref: link.reference, status: 'successful', amount: 25000 } };
      await flwHook(`/${acc.id}`, 'wrong-hash', evt).expect(401);
      await flwHook(`/${acc.id}`, null, evt).expect(401);
      await flwHook('', FLW_HASH, evt).expect(401); // seller hash on the platform route
      expect((await flwHook(`/${acc.id}`, FLW_HASH, evt).expect(200)).body).toMatchObject({ processed: true });
      expect((await order(o.id)).status).toBe('PENDING_PAYMENT'); // body claims success; Flutterwave's verify does not
      flw.succeed(link.reference, o.total);
      const again = { ...evt, data: { ...evt.data, id: evt.data.id + 1 } };
      await flwHook(`/${acc.id}`, FLW_HASH, again).expect(200);
      expect(await order(o.id)).toMatchObject({ status: 'PAID' });
      expect((await txn(link.reference)).verifiedBy).toBe('flutterwave:webhook');
      expect((await flwHook(`/${acc.id}`, FLW_HASH, again).expect(200)).body).toMatchObject({ duplicate: true });

      // An account without a saved secret can't receive webhooks.
      const other = await store();
      const acc2 = (await connect(other.h, 'flutterwave', { secretKey: FLW_KEY }).expect(200)).body.account;
      await flwHook(`/${acc2.id}`, FLW_HASH, again).expect(401);
      // …and another seller's account can't settle this seller's payment.
      await prisma.sellerPaymentAccount.update({ where: { id: acc2.id }, data: { credentialsEnc: crypto.encrypt(JSON.stringify({ secretKey: FLW_KEY, webhookSecret: 'other-seller-hash-0001' }), other.tenantId) } });
      const o2 = await checkout(s);
      const l2 = (await pay(s.slug, o2).expect(200)).body;
      flw.succeed(l2.reference, o2.total);
      expect((await flwHook(`/${acc2.id}`, 'other-seller-hash-0001', { event: 'charge.completed', data: { id: 910_000 + seq++, tx_ref: l2.reference, status: 'successful' } }).expect(200)).body).toMatchObject({ processed: false });
      expect((await order(o2.id)).status).toBe('PENDING_PAYMENT');
    });

    it('Flutterwave platform route settles split payments with the platform hash', async () => {
      const s = await store();
      flw.resolvable.set('0690000034', 'BALE GARY');
      await http.put('/api/v1/payments/settings/flutterwave/split').set(s.h).send({ bankCode: '044', accountNumber: '0690000034' }).expect(200);
      const o = await checkout(s);
      const link = (await pay(s.slug, o).expect(200)).body;
      flw.succeed(link.reference, o.total);
      await flwHook('', process.env.FLUTTERWAVE_WEBHOOK_HASH!, { event: 'charge.completed', data: { id: 920_000 + seq++, tx_ref: link.reference, status: 'successful' } }).expect(200);
      expect((await order(o.id)).status).toBe('PAID');
    });

    it('Bachs: X-Bachs-Signature-V2 per account, stale or forged deliveries refused, refunds settled by webhook', async () => {
      const s = await store();
      const acc = (await connect(s.h, 'bachs', { secretKey: BACHS_KEY, webhookSecret: BACHS_SECRET }).expect(200)).body.account;
      expect(acc.webhookUrl).toMatch(/\/api\/v1\/payments\/bachs\/webhook\//);
      const o = await checkout(s);
      const link = (await pay(s.slug, o).expect(200)).body;
      const t = await txn(link.reference);
      bachs.succeed(link.reference, o.total, { providerReference: 'ch_live1' });
      const evt = { id: `evt_${uniq()}`, type: 'collection.succeeded', data: { checkout_id: t.providerCheckoutId, reference: null, charge_id: 'ch_live1', status: 'SUCCEEDED' } };
      await bachsHook(`/${acc.id}`, 'not-the-secret-value', evt).expect(401);
      await bachsHook(`/${acc.id}`, BACHS_SECRET, evt, Math.floor(Date.now() / 1000) - 600).expect(401); // replay window
      await bachsHook('', BACHS_SECRET, evt).expect(401); // seller secret on the platform route
      expect((await bachsHook(`/${acc.id}`, BACHS_SECRET, evt).expect(200)).body).toMatchObject({ processed: true }); // found by checkout id
      expect(await order(o.id)).toMatchObject({ status: 'PAID' });
      expect((await bachsHook(`/${acc.id}`, BACHS_SECRET, evt).expect(200)).body).toMatchObject({ duplicate: true });

      const rf = (await http.post(`/api/v1/orders/${o.id}/refunds`).set(s.h).send({}).expect(201)).body.refund;
      bachs.refunds.set(rf.providerReference, 'SUCCEEDED');
      await bachsHook(`/${acc.id}`, BACHS_SECRET, { id: `evt_${uniq()}`, type: 'refund.paid', data: { refund_id: rf.providerReference, charge_id: 'ch_live1', status: 'paid' } }).expect(200);
      expect(await prisma.paymentRefund.findUniqueOrThrow({ where: { id: rf.id } })).toMatchObject({ status: 'SUCCEEDED' });
      expect(await order(o.id)).toMatchObject({ status: 'REFUNDED' });
    });

    it('webhooks for an unknown provider path are 404', async () => {
      await http.post('/api/v1/payments/stripe/webhook').send({}).expect(404);
    });
  });

  // ───────────────────────── Admin ─────────────────────────
  it('admin sees all three adapters, their capabilities and whether platform keys are configured', async () => {
    const s = await register();
    await prisma.user.updateMany({ where: { memberships: { some: { tenantId: s.tenantId } } }, data: { platformRole: 'PLATFORM_ADMIN' } });
    const list = (await http.get('/api/v1/admin/payment-providers').set({ Authorization: s.h.Authorization }).expect(200)).body;
    const by = (c: string) => list.find((p: any) => p.code === c);
    expect(by('FLUTTERWAVE')).toMatchObject({ adapterAvailable: true, platformKeyConfigured: true, webhooksEnabled: true, capabilities: { split: true } });
    expect(by('BACHS')).toMatchObject({ adapterAvailable: true, platformKeyConfigured: true, capabilities: { split: false, multipleRefunds: false } });
    expect(by('BANK_TRANSFER')).toMatchObject({ adapterAvailable: false });
  });
});
