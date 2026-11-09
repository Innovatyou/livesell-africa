import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { SubscriptionsService } from '../src/billing/subscriptions.service';
import { configureApp } from '../src/configure-app';
import { MessagingProvider, VerificationProvider } from '../src/messaging/messaging-provider';
import { NotificationService } from '../src/notifications/notifications.service';
import { VeltrixAuthMailer, VeltrixBillingNotifier } from '../src/notifications/veltrix-mailers';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeMessaging, FakeVerification } from './support';

const PASSWORD = 'CorrectHorse42';
const DAY = 86_400_000;
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 1)]);
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
type H = Record<string, string>;

describe('Phase 8 — Veltrix messaging, usage and verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifications: NotificationService;
  let subs: SubscriptionsService;
  let http: ReturnType<typeof request>;
  const fake = new FakeMessaging();
  const verify = new FakeVerification();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MessagingProvider).useValue(fake)
      .overrideProvider(VerificationProvider).useValue(verify)
      // The Veltrix adapters exactly as production binds them when VELTRIX_ENABLED=true.
      .overrideProvider(AuthMailer).useFactory({ factory: (n: NotificationService) => new VeltrixAuthMailer(n), inject: [NotificationService] })
      .overrideProvider(BillingNotifier).useFactory({ factory: (n: NotificationService) => new VeltrixBillingNotifier(n), inject: [NotificationService] })
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    notifications = app.get(NotificationService);
    subs = app.get(SubscriptionsService);
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    await prisma.platformSetting.deleteMany({ where: { key: { in: ['messaging.price_kobo', 'messaging.monthly_limits'] } } });
    await app.close();
  });
  beforeEach(() => {
    fake.enabled = { EMAIL: true, SMS: true, WHATSAPP: true };
    fake.next = { EMAIL: [], SMS: [], WHATSAPP: [] };
    verify.result = { status: 'VERIFIED', matched: true, matchScore: 97, registeredName: 'FASHION BY ADA LTD', checkId: 'chk_fake', environment: 'sandbox', message: 'Verified' };
  });

  async function register(over: Record<string, unknown> = {}) {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p8-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p8-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true, ...over,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { body, tenantId: res.body.tenant.id as string, token: res.body.accessToken as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } as H };
  }
  async function admin() {
    const a = await register();
    await prisma.user.update({ where: { email: a.body.email }, data: { platformRole: 'PLATFORM_ADMIN' } });
    return { Authorization: `Bearer ${a.token}` };
  }
  async function member(tenantId: string, roleKey: string): Promise<H> {
    const other = await register();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId, key: roleKey } });
    const m = await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    await prisma.tenantMember.create({ data: { tenantId, userId: m.userId, roleId: role.id } });
    return { Authorization: other.h.Authorization, 'X-Tenant-Id': tenantId };
  }
  const lastRow = (type: string, destination?: string) => prisma.notification.findFirstOrThrow({ where: { type, ...(destination ? { destination } : {}) }, orderBy: { createdAt: 'desc' } });
  const tokenIn = (html?: string) => decodeURIComponent(/token=([^"&<\s]+)/.exec(html ?? '')![1]);

  // ───────────────────────── Auth messages ─────────────────────────
  describe('auth messages through Veltrix', () => {
    it('sign-up verification email: sent once, the link works, the token is never stored', async () => {
      const a = await register();
      const mail = fake.last('EMAIL', a.body.email)!;
      expect(mail.subject).toBe('Confirm your email address');
      const token = tokenIn(mail.html);
      const row = await lastRow('EMAIL_VERIFICATION', a.body.email);
      expect(row).toMatchObject({ channel: 'EMAIL', status: 'SENT', provider: 'VELTRIX', retryable: false, tenantId: null, providerMessageId: expect.stringMatching(/^em_/) });
      expect(row.payload).toEqual({});
      expect(JSON.stringify(await prisma.notification.findMany({ where: { destination: a.body.email } }))).not.toContain(token);
      expect(mail.key).toBe(`ls-${row.id}-0`);
      await http.post('/api/v1/auth/verify-email').send({ token }).expect(204);
      expect(await prisma.notificationUsage.count({ where: { notificationId: row.id } })).toBe(0); // platform cost, not the seller's
    });

    it('a Veltrix outage never breaks sign-up or password reset; secret messages are marked failed, not retried', async () => {
      fake.next.EMAIL = ['unavailable'];
      const a = await register();
      expect(await lastRow('EMAIL_VERIFICATION', a.body.email)).toMatchObject({ status: 'FAILED', retryable: false, attempts: 1 });
      fake.next.EMAIL = ['unavailable'];
      await http.post('/api/v1/auth/forgot-password').send({ email: a.body.email }).expect(202);
      expect(await lastRow('PASSWORD_RESET', a.body.email)).toMatchObject({ status: 'FAILED' });
      await notifications.retryDue(new Date(Date.now() + DAY));
      expect(await lastRow('PASSWORD_RESET', a.body.email)).toMatchObject({ status: 'FAILED', attempts: 1 });
      // The user simply asks again.
      await http.post('/api/v1/auth/forgot-password').send({ email: a.body.email }).expect(202);
      const reset = fake.last('EMAIL', a.body.email)!;
      expect(reset.subject).toBe('Reset your LiveSell password');
      await http.post('/api/v1/auth/reset-password').send({ token: tokenIn(reset.html), newPassword: 'AnotherHorse77' }).expect(204);
    });

    it('phone OTP by SMS: the code arrives and verifies; no SMS channel or a failed send says so honestly', async () => {
      const a = await register();
      await http.post('/api/v1/auth/phone/send-otp').set(a.h).send({}).expect(200);
      const sms = fake.last('SMS', a.body.phone)!;
      const code = /(\d{6})/.exec(sms.text!)![1];
      expect(JSON.stringify(await lastRow('PHONE_OTP', a.body.phone))).not.toContain(code);
      await http.post('/api/v1/auth/phone/verify').set(a.h).send({ code }).expect(200);

      const b = await register();
      fake.next.SMS = ['reject'];
      const r = await http.post('/api/v1/auth/phone/send-otp').set(b.h).send({}).expect(503);
      expect(r.body.code).toBe('SMS_NOT_SENT');
      fake.enabled.SMS = false;
      await http.post('/api/v1/auth/phone/send-otp').set(b.h).send({}).expect(503);
    });

    it('staff invitation email carries a working invitation link', async () => {
      const a = await register();
      await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200);
      const email = `staff-${uniq()}@example.com`;
      await http.post('/api/v1/staff/invitations').set(a.h).send({ email, roleKey: 'SALES_ASSISTANT' }).expect(201);
      const mail = fake.last('EMAIL', email)!;
      expect(mail.subject).toContain('invited you to LiveSell');
      const look = await http.post('/api/v1/invitations/lookup').send({ token: tokenIn(mail.html) }).expect(200);
      expect(look.body).toMatchObject({ email });
    });
  });

  // ───────────────────────── Reliability (§26 #10) ─────────────────────────
  describe('§26 #10 Veltrix notification fails', () => {
    it('billing email: retried with backoff under the same key after an ambiguous failure, a new key after a definite one, FAILED after 5', async () => {
      const a = await register();
      const sub = await prisma.subscription.findFirstOrThrow({ where: { tenantId: a.tenantId } });
      await prisma.subscription.update({ where: { id: sub.id }, data: { trialEndsAt: new Date(Date.now() + 2 * DAY), currentPeriodEnd: new Date(Date.now() + 2 * DAY) } });
      fake.next.EMAIL = ['unavailable', 'definite', 'unavailable', 'unavailable', 'unavailable'];
      await subs.runLifecycle(new Date()); // sends the trial reminder; the business flow carries on regardless
      const row = await lastRow('BILLING_REMINDER', a.body.email);
      expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, retryable: true });
      expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
      expect(row.payload).toMatchObject({ businessName: a.body.businessName, kind: 'trial_ending' });

      let t = Date.now();
      for (let i = 0; i < 4; i++) {
        t += 3 * 3_600_000;
        await notifications.retryDue(new Date(t));
      }
      const done = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
      expect(done).toMatchObject({ status: 'FAILED', attempts: 5, nextAttemptAt: null });
      const keys = fake.attempts.filter((x) => x.key.startsWith(`ls-${row.id}-`)).map((x) => x.key);
      expect(keys).toEqual([`ls-${row.id}-0`, `ls-${row.id}-0`, `ls-${row.id}-1`, `ls-${row.id}-1`, `ls-${row.id}-1`]);
      expect(fake.sent.some((s) => s.key.startsWith(`ls-${row.id}-`))).toBe(false);

      // An admin re-sends it once Veltrix is back.
      const adm = await admin();
      const failed = (await http.get('/api/v1/admin/messaging/notifications?status=FAILED').set(adm).expect(200)).body;
      expect(failed.items.find((n: any) => n.id === row.id)).toMatchObject({ type: 'BILLING_REMINDER', retryable: true });
      const again = (await http.post(`/api/v1/admin/messaging/notifications/${row.id}/retry`).set(adm).expect(200)).body;
      expect(again).toMatchObject({ status: 'SENT' });
      expect(fake.last('EMAIL', a.body.email)!.key).toBe(`ls-${row.id}-2`);
    });

    it('a message that eventually goes through is sent exactly once, and only one worker claims it', async () => {
      const a = await register();
      fake.next.SMS = ['unavailable'];
      const first = await notifications.send({ tenantId: a.tenantId, channel: 'SMS', type: 'ORDER_ALERT', template: 'TEST_MESSAGE', destination: '08031234567', vars: {} });
      expect(first.status).toBe('QUEUED');
      const later = new Date(Date.now() + 5 * 60_000);
      await Promise.all([notifications.retryDue(later), notifications.retryDue(later), notifications.retryDue(later)]);
      const row = await prisma.notification.findUniqueOrThrow({ where: { id: first.id } });
      expect(row).toMatchObject({ status: 'SENT', attempts: 2, destination: '+2348031234567' });
      expect(fake.sent.filter((s) => s.key.startsWith(`ls-${first.id}-`))).toHaveLength(1);
    });

    it('wallet empty or channel off: recorded as failed with the reason, nothing retried', async () => {
      const a = await register();
      fake.next.WHATSAPP = ['reject'];
      const r = await notifications.send({ tenantId: a.tenantId, channel: 'WHATSAPP', type: 'TEST', template: 'TEST_MESSAGE', destination: '+2348031234567', vars: {} });
      expect(r).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/^INSUFFICIENT_BALANCE/) });
      fake.enabled.EMAIL = false;
      const r2 = await notifications.send({ tenantId: a.tenantId, channel: 'EMAIL', type: 'TEST', template: 'TEST_MESSAGE', destination: 'x@example.com', vars: {} });
      expect(r2).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/^NOT_CONFIGURED/) });
      await expect(notifications.send({ tenantId: a.tenantId, channel: 'SMS', type: 'TEST', template: 'TEST_MESSAGE', destination: '123', vars: {} })).rejects.toThrow(/Invalid phone number/);
    });
  });

  // ───────────────────────── Usage, limits, pricing (§15 messaging billing) ─────────────────────────
  describe('usage tracking, pricing and limits', () => {
    it('seller messages are priced and attributed; limits stop sending; repeats of an event never send twice', async () => {
      const adm = await admin();
      await http.put('/api/v1/admin/messaging/settings').set(adm).send({ limits: { BOGUS: 1 } }).expect(400);
      await http.put('/api/v1/admin/messaging/settings').set(adm).send({ prices: { SMS: -1 } }).expect(400);
      const s = (await http.put('/api/v1/admin/messaging/settings').set(adm).send({ prices: { SMS: 450 }, limits: { SMS: 2 } }).expect(200)).body;
      expect(s).toMatchObject({ prices: { SMS: 450, WHATSAPP: 600, EMAIL: 0 }, limits: { SMS: 2 } });

      const a = await register();
      const send = (dedupeKey?: string) => notifications.send({ tenantId: a.tenantId, channel: 'SMS', type: 'ORDER_ALERT', template: 'TEST_MESSAGE', destination: '+2348031234567', vars: {}, dedupeKey });
      const k = `order:${uniq()}:paid:sms`;
      const one = await send(k);
      const dup = await send(k);
      expect(dup).toMatchObject({ id: one.id, duplicate: true });
      expect(fake.sent.filter((x) => x.key.startsWith(`ls-${one.id}-`))).toHaveLength(1);
      await send();
      const third = await send();
      expect(third).toMatchObject({ status: 'FAILED', error: 'LIMIT_REACHED' });
      expect(await prisma.auditLog.count({ where: { tenantId: a.tenantId, action: 'messaging.limit_reached' } })).toBe(1);
      const usage = await prisma.notificationUsage.findMany({ where: { tenantId: a.tenantId } });
      expect(usage.map((u) => u.costMinor)).toEqual([450n, 450n]);

      const report = (await http.get('/api/v1/messaging/usage').set(a.h).expect(200)).body;
      expect(report.channels.find((c: any) => c.channel === 'SMS')).toMatchObject({ limit: 2, sent: 2, failed: 1, billed: 2, costMinor: '900', enabled: true });
      expect(report.totalCostMinor).toBe('900');
      const list = (await http.get('/api/v1/messaging/notifications').set(a.h).expect(200)).body;
      expect(list.items).toHaveLength(3);
      expect(list.items[0].destination).toBe('+234803•••67'); // masked
      const assistant = await member(a.tenantId, 'SALES_ASSISTANT');
      await http.get('/api/v1/messaging/usage').set(assistant).expect(403);
      const b = await register();
      expect((await http.get('/api/v1/messaging/notifications').set(b.h).expect(200)).body.items).toHaveLength(0); // §26 #9

      const platform = (await http.get('/api/v1/admin/messaging/usage').set(adm).expect(200)).body;
      expect(platform.stores.find((x: any) => x.tenantId === a.tenantId)).toMatchObject({ messages: 2, costMinor: '900', channels: { SMS: 2 } });
      await http.get('/api/v1/admin/messaging/usage').set({ Authorization: a.h.Authorization }).expect(403);
    });

    it('SMS delivery receipts move SENT to DELIVERED or FAILED', async () => {
      const a = await register();
      const ok = await notifications.send({ tenantId: a.tenantId, channel: 'SMS', type: 'T', template: 'TEST_MESSAGE', destination: '+2348031234501', vars: {} });
      const bad = await notifications.send({ tenantId: a.tenantId, channel: 'SMS', type: 'T', template: 'TEST_MESSAGE', destination: '+2348031234502', vars: {} });
      const rows = await prisma.notification.findMany({ where: { id: { in: [ok.id, bad.id] } } });
      fake.delivery.set(rows.find((r) => r.id === ok.id)!.providerMessageId!, 'DELIVERED');
      fake.delivery.set(rows.find((r) => r.id === bad.id)!.providerMessageId!, 'FAILED');
      await notifications.syncDelivery(new Date());
      expect(await prisma.notification.findUniqueOrThrow({ where: { id: ok.id } })).toMatchObject({ status: 'DELIVERED' });
      expect(await prisma.notification.findUniqueOrThrow({ where: { id: bad.id } })).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/carrier/) });
    });
  });

  // ───────────────────────── Admin integration page ─────────────────────────
  describe('integration settings (admin)', () => {
    it('shows the Veltrix connection without secrets, sends a test message, refuses re-sending secrets', async () => {
      const adm = await admin();
      const s = (await http.get('/api/v1/admin/integrations/veltrix').set(adm).expect(200)).body;
      expect(s).toMatchObject({ configured: true, channels: { EMAIL: true, SMS: true, WHATSAPP: true }, account: { name: 'LiveSell Platform' }, verify: { configured: true } });
      const t = (await http.post('/api/v1/admin/integrations/veltrix/test').set(adm).send({ channel: 'WHATSAPP', to: '08031234567' }).expect(200)).body;
      expect(t).toMatchObject({ status: 'SENT' });
      expect(fake.last('WHATSAPP')).toMatchObject({ to: '+2348031234567', text: expect.stringContaining('test') });
      await http.post('/api/v1/admin/integrations/veltrix/test').set(adm).send({ channel: 'FAX', to: 'x' }).expect(400);
      const seller = await register();
      await http.get('/api/v1/admin/integrations/veltrix').set({ Authorization: seller.h.Authorization }).expect(403);

      fake.next.EMAIL = ['unavailable'];
      const a = await register();
      const secret = await lastRow('EMAIL_VERIFICATION', a.body.email);
      await http.post(`/api/v1/admin/messaging/notifications/${secret.id}/retry`).set(adm).expect(400);
    });
  });

  // ───────────────────────── Business verification ─────────────────────────
  describe('automated registry check (Veltrix Verify)', () => {
    async function submit(a: Awaited<ReturnType<typeof register>>, number = 'RC1234567') {
      const p = await http.post('/api/v1/business-verification/upload-url').set(a.h).send({ contentType: 'application/pdf', contentLength: PDF.length }).expect(201);
      expect((await fetch(p.body.uploadUrl, { method: 'PUT', body: PDF, headers: { 'Content-Type': 'application/pdf' } })).status).toBe(200);
      return (await http.post('/api/v1/business-verification').set(a.h).send({ registeredName: 'Fashion By Ada Ltd', registrationType: 'CAC_RC', registrationNumber: number, documentKey: p.body.key }).expect(201)).body;
    }

    it('runs a CAC check on submission and shows it to the reviewer; approval stays a person’s decision', async () => {
      const a = await register({ businessType: 'REGISTERED_BUSINESS' });
      const sub = await submit(a);
      expect(verify.calls.at(-1)).toEqual({ identifier: '1234567', name: 'Fashion By Ada Ltd' });
      const adm = await admin();
      const d = (await http.get(`/api/v1/admin/business-verifications/${sub.id}`).set(adm).expect(200)).body;
      expect(d).toMatchObject({ status: 'PENDING', automatedCheck: { status: 'VERIFIED', matched: true, registeredName: 'FASHION BY ADA LTD', provider: 'VELTRIX_VERIFY' } });
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: a.tenantId } })).verifiedAt).toBeNull();
      verify.result = { status: 'MISMATCH', matched: false, matchScore: 40, registeredName: 'SOMEONE ELSE LTD', checkId: 'c2', environment: 'sandbox', message: null };
      const re = (await http.post(`/api/v1/admin/business-verifications/${sub.id}/registry-check`).set(adm).expect(200)).body;
      expect(re.automatedCheck).toMatchObject({ status: 'MISMATCH', registeredName: 'SOMEONE ELSE LTD' });
      await http.post(`/api/v1/admin/business-verifications/${sub.id}/registry-check`).set({ Authorization: a.h.Authorization }).expect(403);
    });

    it('a Verify outage is recorded and never blocks the submission', async () => {
      verify.result = 'unavailable';
      const a = await register({ businessType: 'REGISTERED_BUSINESS' });
      const sub = await submit(a);
      const row = await prisma.businessVerification.findUniqueOrThrow({ where: { id: sub.id } });
      expect(row.automatedCheck).toMatchObject({ status: 'UNAVAILABLE' });
      expect(row.status).toBe('PENDING');
    });
  });
});
