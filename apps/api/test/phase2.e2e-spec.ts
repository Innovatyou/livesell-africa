import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { BILLING_QUEUE, LIFECYCLE_SCHEDULER } from '../src/billing/billing.jobs';
import { CommissionService } from '../src/billing/commission.service';
import { SubscriptionsService } from '../src/billing/subscriptions.service';
import { PRIVACY_VERSION, TERMS_VERSION } from '../src/legal/versions';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer } from './support';

const PASSWORD = 'CorrectHorse42';
const DAY = 86_400_000;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const seller = (over: Record<string, unknown> = {}) => {
  const u = uniq();
  return {
    businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p2-${u}@example.com`, phone: phone(),
    country: 'NG', state: 'Lagos', city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion',
    storeUsername: `p2-${u}`.slice(0, 40), businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true, ...over,
  };
};
const cookieOf = (res: request.Response) =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ls_rt='))?.split(';')[0];

// Tiny valid file headers (magic bytes) for upload tests.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 1)]);
const PDF = Buffer.from('%PDF-1.4\n% test certificate\n%%EOF\n');

describe('Phase 2 — onboarding, staff, subscriptions, dashboard', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let subs: SubscriptionsService;
  let commission: CommissionService;
  let http: ReturnType<typeof request>;
  const mailer = new CapturingMailer();
  const notifier = new CapturingBillingNotifier();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer).useValue(mailer)
      .overrideProvider(BillingNotifier).useValue(notifier)
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    subs = app.get(SubscriptionsService);
    commission = app.get(CommissionService);
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  async function register(over: Record<string, unknown> = {}) {
    const body = seller(over);
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    const tenantId = res.body.tenant.id as string;
    const token = res.body.accessToken as string;
    return { body, token, tenantId, h: { Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenantId } };
  }
  async function platformAdmin() {
    const a = await register();
    await prisma.user.update({ where: { email: a.body.email }, data: { platformRole: 'PLATFORM_ADMIN' } });
    return { Authorization: `Bearer ${a.token}` };
  }
  const liveSub = (tenantId: string) =>
    prisma.subscription.findFirstOrThrow({ where: { tenantId }, orderBy: { createdAt: 'desc' }, include: { plan: true } });
  async function planId(code: string) {
    return (await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code } })).id;
  }
  /** Simulates a subscription that has already been paid for (as Phase 5's verified payment would leave it). */
  async function makeActive(tenantId: string, code: string, start: Date, end: Date) {
    const s = await liveSub(tenantId);
    await prisma.subscription.update({
      where: { id: s.id }, data: { status: 'ACTIVE', planId: await planId(code), interval: 'MONTHLY', currentPeriodStart: start, currentPeriodEnd: end, trialEndsAt: null },
    });
    return s.id;
  }
  async function putObject(url: string, body: Buffer, contentType: string) {
    return fetch(url, { method: 'PUT', body, headers: { 'Content-Type': contentType } });
  }

  // ───────────────────────── Onboarding ─────────────────────────
  describe('onboarding', () => {
    it('checklist is computed from real data and updates as steps are completed', async () => {
      const a = await register();
      const c1 = await http.get('/api/v1/onboarding').set(a.h).expect(200);
      // Phase 3 added add_product and publish_store (the checklist grows as features ship).
      expect(c1.body.items.map((i: any) => i.key)).toEqual(['verify_email', 'verify_phone', 'store_profile', 'logo', 'add_product', 'publish_store', 'invite_team', 'business_verification']);
      expect(c1.body.completed).toBe(0);
      expect(c1.body.requiredRemaining).toBe(6);

      await http.post('/api/v1/auth/verify-email').send({ token: mailer.verify.get(a.body.email) }).expect(204);
      await http.patch('/api/v1/store/profile').set(a.h).send({ description: 'Handmade Ankara dresses from Lagos.', whatsappNumber: '+2348031234567' }).expect(200);
      const c2 = await http.get('/api/v1/onboarding').set(a.h).expect(200);
      const done = Object.fromEntries(c2.body.items.map((i: any) => [i.key, i.done]));
      expect(done).toMatchObject({ verify_email: true, store_profile: true, verify_phone: false, logo: false });
      expect(c2.body.requiredRemaining).toBe(4);
    });

    it('store profile validates input and requires store:manage', async () => {
      const a = await register();
      const p = await http.patch('/api/v1/store/profile').set(a.h)
        .send({ businessName: 'Ada Couture', socialLinks: { instagram: '@adacouture', website: 'https://ada.example.com' } }).expect(200);
      expect(p.body.businessName).toBe('Ada Couture');
      expect(p.body.storefront.socialLinks).toEqual({ instagram: '@adacouture', website: 'https://ada.example.com' });
      await http.patch('/api/v1/store/profile').set(a.h).send({ whatsappNumber: '0803123' }).expect(400);
      await http.patch('/api/v1/store/profile').set(a.h).send({ socialLinks: { website: 'javascript:alert(1)' } }).expect(400);
      await http.patch('/api/v1/store/profile').set(a.h).send({ socialLinks: { instagram: '<script>' } }).expect(400);
      await http.patch('/api/v1/store/profile').set(a.h).send({ slug: 'hijack' }).expect(400);

      const staff = await register();
      const role = await prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, key: 'SALES_ASSISTANT' } });
      const u = await prisma.user.findUniqueOrThrow({ where: { email: staff.body.email } });
      await prisma.tenantMember.create({ data: { tenantId: a.tenantId, userId: u.id, roleId: role.id } });
      const sh = { Authorization: `Bearer ${staff.token}`, 'X-Tenant-Id': a.tenantId };
      await http.get('/api/v1/store/profile').set(sh).expect(200);
      await http.patch('/api/v1/store/profile').set(sh).send({ description: 'x' }).expect(403);
    });

    it('phone OTP: wrong codes count down, correct code verifies, codes are single use', async () => {
      const a = await register();
      const sent = await http.post('/api/v1/auth/phone/send-otp').set(a.h).send({}).expect(200);
      expect(sent.body.status).toBe('sent');
      expect(sent.body.phone).not.toContain(a.body.phone.slice(4, -3)); // masked
      const code = mailer.otp.get(a.body.phone)!;
      expect(code).toMatch(/^\d{6}$/);
      const wrong = code === '000000' ? '111111' : '000000';
      const bad = await http.post('/api/v1/auth/phone/verify').set(a.h).send({ code: wrong }).expect(400);
      expect(bad.body.message).toMatch(/4 attempts left/);
      await http.post('/api/v1/auth/phone/verify').set(a.h).send({ code: 'abc' }).expect(400);
      await http.post('/api/v1/auth/phone/verify').set(a.h).send({ code }).expect(200);
      await http.post('/api/v1/auth/phone/verify').set(a.h).send({ code }).expect(400);
      expect((await prisma.user.findUniqueOrThrow({ where: { email: a.body.email } })).phoneVerifiedAt).not.toBeNull();
      const again = await http.post('/api/v1/auth/phone/send-otp').set(a.h).send({}).expect(200);
      expect(again.body.status).toBe('already_verified');
    });

    it('phone OTP locks after 5 wrong attempts, enforces resend cooldown, and rejects a taken number', async () => {
      const a = await register();
      await http.post('/api/v1/auth/phone/send-otp').set(a.h).send({}).expect(200);
      const code = mailer.otp.get(a.body.phone)!;
      const wrong = code === '999999' ? '888888' : '999999';
      for (let i = 0; i < 5; i++) await http.post('/api/v1/auth/phone/verify').set(a.h).send({ code: wrong }).expect(400);
      const locked = await http.post('/api/v1/auth/phone/verify').set(a.h).send({ code }).expect(400);
      expect(locked.body.message).toMatch(/Too many|expired/);
      await http.post('/api/v1/auth/phone/send-otp').set(a.h).send({}).expect(429); // 60s cooldown

      const b = await register();
      await http.post('/api/v1/auth/phone/send-otp').set(b.h).send({ phone: a.body.phone }).expect(409);
      await http.post('/api/v1/auth/phone/send-otp').set(b.h).send({ phone: '0801' }).expect(400);
    });

    it('logo upload: presigned PUT to S3, server confirms size/type/magic bytes, single use, tenant-bound', async () => {
      const a = await register();
      const b = await register();
      await http.post('/api/v1/store/logo/upload-url').set(a.h).send({ contentType: 'image/svg+xml', contentLength: 100 }).expect(400);
      await http.post('/api/v1/store/logo/upload-url').set(a.h).send({ contentType: 'image/png', contentLength: 3 * 1024 * 1024 }).expect(400);

      const p = await http.post('/api/v1/store/logo/upload-url').set(a.h).send({ contentType: 'image/png', contentLength: PNG.length }).expect(201);
      expect(p.body.key).toMatch(new RegExp(`^tenants/${a.tenantId}/logos/[0-9a-f-]{36}\\.png$`));
      const put = await putObject(p.body.uploadUrl, PNG, 'image/png');
      expect(put.status).toBe(200);

      await http.put('/api/v1/store/logo').set(b.h).send({ key: p.body.key }).expect(400); // other tenant
      const ok = await http.put('/api/v1/store/logo').set(a.h).send({ key: p.body.key }).expect(200);
      expect(ok.body.logoUrl).toContain(p.body.key);
      const img = await fetch(ok.body.logoUrl);
      expect(img.status).toBe(200);
      await http.put('/api/v1/store/logo').set(a.h).send({ key: p.body.key }).expect(400); // single use
      const profile = await http.get('/api/v1/store/profile').set(a.h).expect(200);
      expect(profile.body.storefront.logoUrl).toContain(p.body.key);
      expect((await http.get('/api/v1/onboarding').set(a.h)).body.items.find((i: any) => i.key === 'logo').done).toBe(true);
    });

    it('logo upload rejects disguised files and size mismatches', async () => {
      const a = await register();
      const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(128, ' '));
      const p = await http.post('/api/v1/store/logo/upload-url').set(a.h).send({ contentType: 'image/png', contentLength: html.length }).expect(201);
      expect((await putObject(p.body.uploadUrl, html, 'image/png')).status).toBe(200);
      await http.put('/api/v1/store/logo').set(a.h).send({ key: p.body.key }).expect(400);
      // The disguised object was deleted.
      const r = await fetch(p.body.uploadUrl.replace(/\?.*$/, ''), { method: 'HEAD' });
      expect([403, 404]).toContain(r.status);

      const q = await http.post('/api/v1/store/logo/upload-url').set(a.h).send({ contentType: 'image/png', contentLength: 50 }).expect(201);
      const mismatch = await putObject(q.body.uploadUrl, PNG, 'image/png'); // 128 bytes ≠ signed 50
      expect(mismatch.ok).toBe(false);
      const wrongType = await putObject(q.body.uploadUrl, PNG.subarray(0, 50), 'image/jpeg');
      expect(wrongType.ok).toBe(false);
    });

    it('business verification: private upload, one pending request, platform admin approves', async () => {
      const a = await register({ businessType: 'REGISTERED_BUSINESS' });
      const p = await http.post('/api/v1/business-verification/upload-url').set(a.h).send({ contentType: 'application/pdf', contentLength: PDF.length }).expect(201);
      expect(p.body.key).toContain(`tenants/${a.tenantId}/private/verification/`);
      expect((await putObject(p.body.uploadUrl, PDF, 'application/pdf')).status).toBe(200);
      const sub = await http.post('/api/v1/business-verification').set(a.h)
        .send({ registeredName: 'Fashion By Ada Ltd', registrationType: 'CAC_RC', registrationNumber: 'rc1234567', documentKey: p.body.key }).expect(201);
      expect(sub.body.status).toBe('PENDING');
      await http.post('/api/v1/business-verification').set(a.h)
        .send({ registeredName: 'Again', registrationType: 'CAC_RC', registrationNumber: 'RC1234567', documentKey: p.body.key }).expect(409);

      // Sellers cannot use the admin endpoints.
      await http.get('/api/v1/admin/business-verifications').set({ Authorization: `Bearer ${a.token}` }).expect(403);
      const admin = await platformAdmin();
      const list = await http.get('/api/v1/admin/business-verifications').set(admin).expect(200);
      expect(list.body.some((r: any) => r.id === sub.body.id)).toBe(true);
      const detail = await http.get(`/api/v1/admin/business-verifications/${sub.body.id}`).set(admin).expect(200);
      expect(detail.body.registrationNumber).toBe('RC1234567');
      expect(detail.body.documentKey).toBeUndefined();
      expect((await fetch(detail.body.documentUrl)).status).toBe(200); // presigned
      expect((await fetch(detail.body.documentUrl.replace(/\?.*$/, ''))).status).toBe(403); // not public

      await http.post(`/api/v1/admin/business-verifications/${sub.body.id}/approve`).set(admin).expect(200);
      await http.post(`/api/v1/admin/business-verifications/${sub.body.id}/reject`).set(admin).send({ reason: 'Changed my mind' }).expect(409);
      const st = await http.get('/api/v1/business-verification').set(a.h).expect(200);
      expect(st.body.verifiedAt).not.toBeNull();
      expect(st.body.latest.status).toBe('APPROVED');
      expect((await http.get('/api/v1/onboarding').set(a.h)).body.items.find((i: any) => i.key === 'business_verification').done).toBe(true);
    });
  });

  // ───────────────────────── Staff invitations ─────────────────────────
  describe('staff invitations', () => {
    async function professional(over: Record<string, unknown> = {}) {
      const a = await register(over);
      await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200);
      return a;
    }

    it('Starter allows only the owner; seats count pending invitations', async () => {
      const a = await register();
      const r = await http.post('/api/v1/staff/invitations').set(a.h).send({ email: `s-${uniq()}@example.com`, roleKey: 'SALES_ASSISTANT' }).expect(403);
      expect(r.body.code).toBe('PLAN_LIMIT_REACHED');

      await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200);
      for (let i = 0; i < 4; i++) {
        await http.post('/api/v1/staff/invitations').set(a.h).send({ email: `s${i}-${uniq()}@example.com`, roleKey: 'SALES_ASSISTANT' }).expect(201);
      }
      const fifth = await http.post('/api/v1/staff/invitations').set(a.h).send({ email: `s5-${uniq()}@example.com`, roleKey: 'SALES_ASSISTANT' }).expect(403);
      expect(fifth.body.code).toBe('PLAN_LIMIT_REACHED'); // owner + 4 pending = 5 seats
      await http.post('/api/v1/staff/invitations').set(a.h).send({ email: `x-${uniq()}@example.com`, roleKey: 'OWNER' }).expect(400);
    });

    it('new person accepts: account created, signed in, joined with the invited role; token is single use', async () => {
      const a = await professional();
      const email = `new-${uniq()}@example.com`;
      await http.post('/api/v1/staff/invitations').set(a.h).send({ email, roleKey: 'LIVE_MODERATOR' }).expect(201);
      await http.post('/api/v1/staff/invitations').set(a.h).send({ email, roleKey: 'LIVE_MODERATOR' }).expect(409);
      const token = mailer.invites.get(email)!.token;

      const info = await http.post('/api/v1/invitations/lookup').send({ token }).expect(200);
      expect(info.body).toMatchObject({ businessName: a.body.businessName, roleName: 'Live moderator', email, accountExists: false });

      const acc = await http.post('/api/v1/invitations/accept-new').send({ token, fullName: 'Tunde Bello', password: 'ModeratorPass1', acceptTerms: true }).expect(201);
      expect(acc.body.accessToken).toBeDefined();
      expect(cookieOf(acc)).toBeDefined();
      const ws = await http.get('/api/v1/workspace').set({ Authorization: `Bearer ${acc.body.accessToken}`, 'X-Tenant-Id': a.tenantId }).expect(200);
      expect(ws.body.role).toBe('LIVE_MODERATOR');
      expect((await prisma.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).not.toBeNull();

      await http.post('/api/v1/invitations/accept-new').send({ token, fullName: 'Again', password: 'ModeratorPass1', acceptTerms: true }).expect(404);
      await http.post('/api/v1/invitations/accept-new').send({ token, fullName: 'No Terms', password: 'ModeratorPass1' }).expect(400);
      await http.post('/api/v1/invitations/lookup').send({ token }).expect(404);
    });

    it('existing user accepts only with the invited email', async () => {
      const a = await professional();
      const invitee = await register();
      const stranger = await register();
      await http.post('/api/v1/staff/invitations').set(a.h).send({ email: invitee.body.email, roleKey: 'STORE_MANAGER' }).expect(201);
      const token = mailer.invites.get(invitee.body.email)!.token;
      expect((await http.post('/api/v1/invitations/lookup').send({ token })).body.accountExists).toBe(true);
      await http.post('/api/v1/invitations/accept-new').send({ token, fullName: 'X Y', password: 'SomethingLong1', acceptTerms: true }).expect(409);
      await http.post('/api/v1/invitations/accept').set({ Authorization: `Bearer ${stranger.token}` }).send({ token }).expect(403);
      const ok = await http.post('/api/v1/invitations/accept').set({ Authorization: `Bearer ${invitee.token}` }).send({ token }).expect(200);
      expect(ok.body.tenant.id).toBe(a.tenantId);
      const me = await http.get('/api/v1/auth/me').set({ Authorization: `Bearer ${invitee.token}` }).expect(200);
      expect(me.body.memberships).toHaveLength(2);
    });

    it('resend rotates the link, revoke kills it', async () => {
      const a = await professional();
      const email = `r-${uniq()}@example.com`;
      const inv = await http.post('/api/v1/staff/invitations').set(a.h).send({ email, roleKey: 'SALES_ASSISTANT' }).expect(201);
      const first = mailer.invites.get(email)!.token;
      await http.post(`/api/v1/staff/invitations/${inv.body.id}/resend`).set(a.h).expect(200);
      const second = mailer.invites.get(email)!.token;
      expect(second).not.toBe(first);
      await http.post('/api/v1/invitations/lookup').send({ token: first }).expect(404);
      await http.post('/api/v1/invitations/lookup').send({ token: second }).expect(200);
      await http.delete(`/api/v1/staff/invitations/${inv.body.id}`).set(a.h).expect(204);
      await http.post('/api/v1/invitations/lookup').send({ token: second }).expect(404);
      const list = await http.get('/api/v1/staff/invitations').set(a.h).expect(200);
      expect(list.body.find((i: any) => i.id === inv.body.id)).toBeUndefined();
    });

    it('members: owner and self are protected; disabling removes access at once; other tenants cannot touch them', async () => {
      const a = await professional();
      const b = await professional();
      const email = `m-${uniq()}@example.com`;
      await http.post('/api/v1/staff/invitations').set(a.h).send({ email, roleKey: 'SALES_ASSISTANT' }).expect(201);
      const acc = await http.post('/api/v1/invitations/accept-new').send({ token: mailer.invites.get(email)!.token, fullName: 'Staff One', password: 'StaffPassword1', acceptTerms: true }).expect(201);
      const sh = { Authorization: `Bearer ${acc.body.accessToken}`, 'X-Tenant-Id': a.tenantId };

      const members = (await http.get('/api/v1/workspace/members').set(a.h).expect(200)).body;
      const owner = members.find((m: any) => m.role.key === 'OWNER');
      const staff = members.find((m: any) => m.user.email === email);
      await http.patch(`/api/v1/staff/members/${owner.id}`).set(a.h).send({ status: 'DISABLED' }).expect(403);
      await http.patch(`/api/v1/staff/members/${staff.id}`).set(b.h).send({ status: 'DISABLED' }).expect(404); // cross-tenant
      await http.patch(`/api/v1/staff/members/${staff.id}`).set(a.h).send({ roleKey: 'STORE_MANAGER' }).expect(200);
      expect((await http.get('/api/v1/workspace').set(sh).expect(200)).body.role).toBe('STORE_MANAGER');
      await http.patch(`/api/v1/staff/members/${staff.id}`).set(a.h).send({ status: 'DISABLED' }).expect(200);
      await http.get('/api/v1/workspace').set(sh).expect(403);

      const pending = await http.post('/api/v1/staff/invitations').set(a.h).send({ email: `p-${uniq()}@example.com`, roleKey: 'SALES_ASSISTANT' }).expect(201);
      await http.delete(`/api/v1/staff/invitations/${pending.body.id}`).set(b.h).expect(404); // cross-tenant
    });
  });

  // ───────────────────────── Subscriptions ─────────────────────────
  describe('subscription plans and billing', () => {
    it('lists public plans with kobo prices as strings', async () => {
      const r = await http.get('/api/v1/plans').expect(200);
      const codes = r.body.map((p: any) => p.code);
      expect(codes.slice(0, 4)).toEqual(['STARTER', 'PROFESSIONAL', 'BUSINESS', 'ENTERPRISE']);
      const starter = r.body.find((p: any) => p.code === 'STARTER');
      expect(starter.monthlyPriceMinor).toBe('500000');
      expect(r.body.find((p: any) => p.code === 'ENTERPRISE').monthlyPriceMinor).toBeNull();
    });

    it('platform admin creates and edits plans; validation is strict; sellers are refused', async () => {
      const a = await register();
      await http.get('/api/v1/admin/plans').set({ Authorization: `Bearer ${a.token}` }).expect(403);
      const admin = await platformAdmin();
      const code = `GROWTH_${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, 30);
      const limits = { products: 100, ordersPerMonth: 500, staff: 3, paymentGateways: 1 };
      await http.post('/api/v1/admin/plans').set(admin).send({ code, name: 'Growth', monthlyPriceMinor: 800000, annualPriceMinor: null, limits, features: {} }).expect(400); // number, not string
      await http.post('/api/v1/admin/plans').set(admin).send({ code, name: 'Growth', monthlyPriceMinor: '800000', annualPriceMinor: null, limits: { products: 1 }, features: {} }).expect(400);
      await http.post('/api/v1/admin/plans').set(admin).send({ code, name: 'Growth', monthlyPriceMinor: '-1', annualPriceMinor: null, limits, features: {} }).expect(400);
      await http.post('/api/v1/admin/plans').set(admin).send({ code, name: 'Growth', monthlyPriceMinor: '800000', annualPriceMinor: null, limits, features: { 'bad key': 1 } }).expect(400);
      const created = await http.post('/api/v1/admin/plans').set(admin)
        .send({ code, name: 'Growth', monthlyPriceMinor: '800000', annualPriceMinor: '8000000', limits, features: { analytics: 'standard' }, isPublic: false, sortOrder: 50 }).expect(201);
      expect(created.body.monthlyPriceMinor).toBe('800000');
      await http.post('/api/v1/admin/plans').set(admin).send({ code, name: 'Dup', monthlyPriceMinor: '1', annualPriceMinor: null, limits, features: {} }).expect(409);
      const upd = await http.patch(`/api/v1/admin/plans/${created.body.id}`).set(admin).send({ monthlyPriceMinor: '900000', trialDays: 7 }).expect(200);
      expect(upd.body.monthlyPriceMinor).toBe('900000');
      expect(upd.body.trialDays).toBe(7);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'plan.updated', entityId: created.body.id } });
      expect(audit.metadata).toMatchObject({ priceBefore: { monthly: '800000' }, priceAfter: { monthly: '900000' } });
      expect((await http.get('/api/v1/plans')).body.find((p: any) => p.code === code)).toBeUndefined(); // private
    });

    it('trial: switching plan is immediate and free; custom-priced plans need sales', async () => {
      const a = await register();
      await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'BUSINESS', interval: 'ANNUAL' }).expect(200);
      let o = (await http.get('/api/v1/billing/subscription').set(a.h).expect(200)).body;
      expect(o.subscription).toMatchObject({ status: 'TRIALING', interval: 'ANNUAL', plan: { code: 'BUSINESS' } });
      expect(o.openInvoices).toHaveLength(0);
      expect(o.paymentCollectionEnabled).toBe(false);
      await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'BUSINESS', interval: 'ANNUAL' }).expect(409);
      await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'ENTERPRISE', interval: 'MONTHLY' }).expect(400);
      await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'NOPE', interval: 'MONTHLY' }).expect(404);
      const hist = (await http.get('/api/v1/billing/history').set(a.h).expect(200)).body.map((e: any) => e.type);
      expect(hist).toEqual(expect.arrayContaining(['TRIAL_STARTED', 'PLAN_CHANGED']));
      o = (await http.get('/api/v1/billing/subscription').set(a.h)).body;
      expect(o.usage).toEqual({ staff: 1, products: 0 });
    });

    it('active upgrade opens a prorated invoice; plan switches only when the verified payment is applied', async () => {
      const a = await register();
      const now = Date.now();
      await makeActive(a.tenantId, 'STARTER', new Date(now - 15 * DAY), new Date(now + 15 * DAY));
      const r = await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200);
      expect(r.body.action).toBe('payment_required');
      const amount = BigInt(r.body.invoice.amountMinor);
      expect(amount).toBeGreaterThan(340_000n); // ≈ (₦12,000 − ₦5,000) × ½ = ₦3,500
      expect(amount).toBeLessThanOrEqual(350_001n);
      expect((await liveSub(a.tenantId)).plan.code).toBe('STARTER'); // not switched yet

      const pay = await http.post(`/api/v1/billing/invoices/${r.body.invoice.id}/pay`).set(a.h).expect(503);
      expect(pay.body.code).toBe('PAYMENTS_NOT_ENABLED');

      // Phase 5 calls this after server-side verification. Idempotent.
      expect(await subs.applyPaidInvoice(r.body.invoice.id, new Date(), null)).toEqual({ applied: true });
      expect(await subs.applyPaidInvoice(r.body.invoice.id, new Date(), null)).toEqual({ applied: false });
      const s = await liveSub(a.tenantId);
      expect(s.plan.code).toBe('PROFESSIONAL');
      expect(s.status).toBe('ACTIVE');
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: a.tenantId } })).status).toBe('ACTIVE');
    });

    it('a second upgrade voids the first open upgrade invoice', async () => {
      const a = await register();
      await makeActive(a.tenantId, 'STARTER', new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      const first = await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200);
      await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'BUSINESS', interval: 'MONTHLY' }).expect(200);
      expect((await prisma.subscriptionInvoice.findUniqueOrThrow({ where: { id: first.body.invoice.id } })).status).toBe('VOID');
      expect(await prisma.subscriptionInvoice.count({ where: { tenantId: a.tenantId, status: 'OPEN' } })).toBe(1);
    });

    it('downgrade is scheduled for period end, must fit usage, and can be cancelled', async () => {
      const a = await register();
      await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200);
      await http.post('/api/v1/staff/invitations').set(a.h).send({ email: `d-${uniq()}@example.com`, roleKey: 'SALES_ASSISTANT' }).expect(201);
      await makeActive(a.tenantId, 'PROFESSIONAL', new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));

      const tooBig = await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'STARTER', interval: 'MONTHLY' }).expect(409);
      expect(tooBig.body.code).toBe('USAGE_EXCEEDS_PLAN');
      const inv = (await http.get('/api/v1/staff/invitations').set(a.h)).body[0];
      await http.delete(`/api/v1/staff/invitations/${inv.id}`).set(a.h).expect(204);

      const r = await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'STARTER', interval: 'MONTHLY' }).expect(200);
      expect(r.body.action).toBe('scheduled');
      const o = (await http.get('/api/v1/billing/subscription').set(a.h)).body;
      expect(o.subscription.plan.code).toBe('PROFESSIONAL');
      expect(o.subscription.pendingChange.plan.code).toBe('STARTER');
      await http.post('/api/v1/billing/subscription/cancel-pending-change').set(a.h).expect(200);
      expect((await http.get('/api/v1/billing/subscription').set(a.h)).body.subscription.pendingChange).toBeNull();
      await http.post('/api/v1/billing/subscription/cancel-pending-change').set(a.h).expect(409);
    });

    it('billing requires billing:manage', async () => {
      const a = await register();
      const staff = await register();
      const role = await prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, key: 'STORE_MANAGER' } });
      const u = await prisma.user.findUniqueOrThrow({ where: { email: staff.body.email } });
      await prisma.tenantMember.create({ data: { tenantId: a.tenantId, userId: u.id, roleId: role.id } });
      const sh = { Authorization: `Bearer ${staff.token}`, 'X-Tenant-Id': a.tenantId };
      await http.get('/api/v1/billing/subscription').set(sh).expect(403);
      await http.post('/api/v1/billing/subscription/change').set(sh).send({ planCode: 'BUSINESS', interval: 'MONTHLY' }).expect(403);
    });
  });

  // ───────────────────────── Subscription lifecycle (BullMQ job body) ─────────────────────────
  describe('subscription lifecycle', () => {
    it('§26 #8: trial ends → past due with invoice → grace expires → writes blocked, reads allowed → reactivation restores access', async () => {
      const a = await register();
      const s0 = await liveSub(a.tenantId);
      const trialEnd = new Date(Date.now() - 60_000);
      await prisma.subscription.update({ where: { id: s0.id }, data: { trialEndsAt: trialEnd, currentPeriodEnd: trialEnd } });

      await subs.runLifecycle(new Date());
      let s = await liveSub(a.tenantId);
      expect(s.status).toBe('PAST_DUE');
      const inv = await prisma.subscriptionInvoice.findFirstOrThrow({ where: { subscriptionId: s.id, status: 'OPEN' } });
      expect(inv).toMatchObject({ kind: 'TRIAL_CONVERSION', amountMinor: 500_000n, currency: 'NGN' });
      expect(notifier.overdue.some((n) => n.to === a.body.email && n.invoiceNumber === inv.number)).toBe(true);
      await http.patch('/api/v1/store/profile').set(a.h).send({ description: 'Still in grace period' }).expect(200);

      // Grace period (3 days) elapses.
      await prisma.subscription.update({ where: { id: s.id }, data: { currentPeriodEnd: new Date(Date.now() - 4 * DAY) } });
      const r = await subs.runLifecycle(new Date());
      expect(r.expired).toBeGreaterThanOrEqual(1);
      s = await liveSub(a.tenantId);
      expect(s.status).toBe('EXPIRED');
      expect((await prisma.subscriptionInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('VOID');
      expect(notifier.expired.some((n) => n.to === a.body.email)).toBe(true);

      const blocked = await http.patch('/api/v1/store/profile').set(a.h).send({ description: 'blocked' }).expect(402);
      expect(blocked.body.code).toBe('SUBSCRIPTION_INACTIVE');
      await http.get('/api/v1/store/profile').set(a.h).expect(200);
      await http.get('/api/v1/onboarding').set(a.h).expect(200);

      const re = await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'STARTER', interval: 'MONTHLY' }).expect(200);
      expect(re.body.invoice.kind).toBe('REACTIVATION');
      await subs.applyPaidInvoice(re.body.invoice.id, new Date(), null);
      s = await liveSub(a.tenantId);
      expect(s.status).toBe('ACTIVE');
      expect(s.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 27 * DAY);
      await http.patch('/api/v1/store/profile').set(a.h).send({ description: 'Back in business' }).expect(200);
    });

    it('renewal applies a scheduled downgrade and invoices the new plan; payment moves into the new period', async () => {
      const a = await register();
      const end = new Date(Date.now() - 1000);
      await makeActive(a.tenantId, 'BUSINESS', new Date(end.getTime() - 30 * DAY), new Date(Date.now() + 10 * DAY));
      await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200);
      await prisma.subscription.updateMany({ where: { tenantId: a.tenantId }, data: { currentPeriodEnd: end } });

      await subs.runLifecycle(new Date());
      const s = await liveSub(a.tenantId);
      expect(s).toMatchObject({ status: 'PAST_DUE', pendingPlanId: null });
      expect(s.plan.code).toBe('PROFESSIONAL');
      const inv = await prisma.subscriptionInvoice.findFirstOrThrow({ where: { subscriptionId: s.id, status: 'OPEN' } });
      expect(inv).toMatchObject({ kind: 'RENEWAL', amountMinor: 1_200_000n });
      expect(inv.periodStart.getTime()).toBe(end.getTime());

      await subs.applyPaidInvoice(inv.id, new Date(), null);
      const paid = await liveSub(a.tenantId);
      expect(paid.status).toBe('ACTIVE');
      expect(paid.currentPeriodStart.getTime()).toBe(end.getTime());
    });

    it('scheduled cancellation ends the subscription at period end without an invoice', async () => {
      const a = await register();
      await http.post('/api/v1/billing/subscription/cancel').set(a.h).expect(200);
      await http.post('/api/v1/billing/subscription/cancel').set(a.h).expect(409);
      await http.post('/api/v1/billing/subscription/resume').set(a.h).expect(200);
      await http.post('/api/v1/billing/subscription/cancel').set(a.h).expect(200);
      const s0 = await liveSub(a.tenantId);
      await prisma.subscription.update({ where: { id: s0.id }, data: { trialEndsAt: new Date(Date.now() - 1000), currentPeriodEnd: new Date(Date.now() - 1000) } });
      await subs.runLifecycle(new Date());
      expect((await liveSub(a.tenantId)).status).toBe('CANCELLED');
      expect(await prisma.subscriptionInvoice.count({ where: { tenantId: a.tenantId } })).toBe(0);
    });

    it('lifecycle is idempotent under concurrent runs', async () => {
      const a = await register();
      const s0 = await liveSub(a.tenantId);
      await prisma.subscription.update({ where: { id: s0.id }, data: { trialEndsAt: new Date(Date.now() - 1000), currentPeriodEnd: new Date(Date.now() - 1000) } });
      await Promise.all([subs.runLifecycle(new Date()), subs.runLifecycle(new Date()), subs.runLifecycle(new Date())]);
      expect(await prisma.subscriptionInvoice.count({ where: { tenantId: a.tenantId } })).toBe(1);
      expect(await prisma.subscriptionEvent.count({ where: { tenantId: a.tenantId, type: 'TRIAL_ENDED' } })).toBe(1);
    });

    it('renewal reminders: one per threshold, retried if sending fails', async () => {
      const a = await register();
      const s0 = await liveSub(a.tenantId);
      const end = new Date(Date.now() + 2 * DAY - 60_000); // 2 days left → the 3-day reminder
      await prisma.subscription.update({ where: { id: s0.id }, data: { trialEndsAt: end, currentPeriodEnd: end } });

      notifier.failNext = 1;
      await subs.runLifecycle(new Date());
      expect(notifier.reminders.filter((r) => r.to === a.body.email)).toHaveLength(0);
      expect(await prisma.subscriptionEvent.count({ where: { subscriptionId: s0.id, type: 'REMINDER_SENT' } })).toBe(0);

      await subs.runLifecycle(new Date());
      await subs.runLifecycle(new Date());
      const mine = notifier.reminders.filter((r) => r.to === a.body.email);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ kind: 'trial_ending', daysLeft: 2 });
      expect(await prisma.subscriptionEvent.count({ where: { subscriptionId: s0.id, type: 'REMINDER_SENT' } })).toBe(1);
    });

    it('the lifecycle job scheduler registers in Redis (BullMQ)', async () => {
      const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
      const queue = new Queue(`${BILLING_QUEUE}-e2e-${uniq()}`, { connection: conn });
      try {
        await queue.upsertJobScheduler(LIFECYCLE_SCHEDULER, { every: 15 * 60_000 }, { name: 'lifecycle' });
        await queue.upsertJobScheduler(LIFECYCLE_SCHEDULER, { every: 15 * 60_000 }, { name: 'lifecycle' }); // idempotent
        const schedulers = await queue.getJobSchedulers();
        expect(schedulers.map((s) => s.key)).toEqual([LIFECYCLE_SCHEDULER]);
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
        await conn.quit();
      }
    });
  });

  // ───────────────────────── Pricing models: subscription vs commission ─────────────────────────
  describe('commission-based and subscription-based sellers', () => {
    it('public plans expose the commission option with its rate and no fixed fee', async () => {
      const plans = (await http.get('/api/v1/plans').expect(200)).body;
      const c = plans.find((p: any) => p.code === 'PAY_AS_YOU_SELL');
      expect(c).toMatchObject({ pricingModel: 'COMMISSION', commissionBps: 300, monthlyPriceMinor: '0', annualPriceMinor: '0' });
      expect(plans.find((p: any) => p.code === 'STARTER')).toMatchObject({ pricingModel: 'SUBSCRIPTION', commissionBps: null });
    });

    it('registration starts on a subscription plan and records the accepted legal versions', async () => {
      const a = await register();
      const t = await prisma.tenant.findUniqueOrThrow({ where: { id: a.tenantId } });
      expect(t).toMatchObject({ termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION });
      expect((await liveSub(a.tenantId)).plan.pricingModel).toBe('SUBSCRIPTION');
    });

    it('a seller can choose commission: free trial, then renews every month with no invoice; commission applies after the trial', async () => {
      const a = await register();
      const r = await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PAY_AS_YOU_SELL', interval: 'ANNUAL' }).expect(200);
      expect(r.body.action).toBe('changed');
      let s = await liveSub(a.tenantId);
      expect(s).toMatchObject({ status: 'TRIALING', interval: 'MONTHLY' }); // commission plans are always monthly
      expect(await commission.effectiveRate(a.tenantId)).toEqual({ bps: 0, source: 'trial', pricingModel: 'COMMISSION' });
      const o = (await http.get('/api/v1/billing/subscription').set(a.h).expect(200)).body;
      expect(o.subscription.plan).toMatchObject({ pricingModel: 'COMMISSION', commissionBps: 300 });
      expect(o.commission).toEqual({ bps: 0, source: 'trial', pricingModel: 'COMMISSION' });

      const trialEnd = new Date(Date.now() - 1000);
      await prisma.subscription.update({ where: { id: s.id }, data: { trialEndsAt: trialEnd, currentPeriodEnd: trialEnd } });
      await subs.runLifecycle(new Date());
      s = await liveSub(a.tenantId);
      expect(s.status).toBe('ACTIVE');
      expect(s.currentPeriodStart.getTime()).toBe(trialEnd.getTime());
      expect(await prisma.subscriptionInvoice.count({ where: { tenantId: a.tenantId } })).toBe(0);
      expect(notifier.overdue.some((n) => n.to === a.body.email)).toBe(false);
      expect(await commission.effectiveRate(a.tenantId)).toEqual({ bps: 300, source: 'plan', pricingModel: 'COMMISSION' });

      // Next month: renews in place, still no invoice, recorded in history.
      await prisma.subscription.update({ where: { id: s.id }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });
      const run = await subs.runLifecycle(new Date());
      expect(run.renewedWithoutCharge).toBeGreaterThanOrEqual(1);
      expect((await liveSub(a.tenantId)).status).toBe('ACTIVE');
      expect(await prisma.subscriptionInvoice.count({ where: { tenantId: a.tenantId } })).toBe(0);
      expect(await prisma.subscriptionEvent.count({ where: { tenantId: a.tenantId, type: 'RENEWED' } })).toBe(1);
      await http.patch('/api/v1/store/profile').set(a.h).send({ description: 'Commission seller, still active' }).expect(200);
    });

    it('commission → subscription is an upgrade (invoice); subscription → commission waits for period end', async () => {
      const a = await register();
      await makeActive(a.tenantId, 'PAY_AS_YOU_SELL', new Date(Date.now() - 10 * DAY), new Date(Date.now() + 20 * DAY));
      const up = await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PROFESSIONAL', interval: 'MONTHLY' }).expect(200);
      expect(up.body.action).toBe('payment_required');
      expect(BigInt(up.body.invoice.amountMinor)).toBeGreaterThan(0n);
      await subs.applyPaidInvoice(up.body.invoice.id, new Date(), null);
      expect(await commission.effectiveRate(a.tenantId)).toEqual({ bps: 0, source: 'platform_default', pricingModel: 'SUBSCRIPTION' });

      const down = await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PAY_AS_YOU_SELL', interval: 'MONTHLY' }).expect(200);
      expect(down.body.action).toBe('scheduled');
      expect((await liveSub(a.tenantId)).plan.code).toBe('PROFESSIONAL');
    });

    it('an expired seller can restart on commission immediately (nothing to pay)', async () => {
      const a = await register();
      const s = await liveSub(a.tenantId);
      await prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED', endedAt: new Date() } });
      await http.patch('/api/v1/store/profile').set(a.h).send({ description: 'blocked' }).expect(402);
      const r = await http.post('/api/v1/billing/subscription/change').set(a.h).send({ planCode: 'PAY_AS_YOU_SELL', interval: 'MONTHLY' }).expect(200);
      expect(r.body.action).toBe('changed');
      expect(r.body.invoice).toMatchObject({ kind: 'REACTIVATION', amountMinor: '0' });
      expect((await liveSub(a.tenantId)).status).toBe('ACTIVE');
      await http.patch('/api/v1/store/profile').set(a.h).send({ description: 'back' }).expect(200);
    });

    it('a negotiated per-seller rate overrides the plan; subscription sellers use the platform default', async () => {
      const a = await register();
      await makeActive(a.tenantId, 'PAY_AS_YOU_SELL', new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      const paystack = await prisma.paymentProvider.findUniqueOrThrow({ where: { code: 'PAYSTACK' } });
      await prisma.forTenant(a.tenantId).sellerPaymentAccount.create({ data: { providerId: paystack.id, settlementMode: 'SPLIT', commissionBps: 150 } as any });
      expect(await commission.effectiveRate(a.tenantId, 'PAYSTACK')).toEqual({ bps: 150, source: 'seller_override', pricingModel: 'COMMISSION' });
      expect(await commission.effectiveRate(a.tenantId, 'FLUTTERWAVE')).toEqual({ bps: 300, source: 'plan', pricingModel: 'COMMISSION' });

      const b = await register();
      await makeActive(b.tenantId, 'STARTER', new Date(Date.now() - DAY), new Date(Date.now() + 29 * DAY));
      expect(await commission.effectiveRate(b.tenantId)).toMatchObject({ source: 'platform_default', pricingModel: 'SUBSCRIPTION' });
      const c = await register();
      await prisma.subscription.updateMany({ where: { tenantId: c.tenantId }, data: { status: 'EXPIRED' } });
      expect(await commission.effectiveRate(c.tenantId)).toBeNull();
    });

    it('admin plan validation enforces the pricing-model rules and blocks model changes on plans in use', async () => {
      const admin = await platformAdmin();
      const limits = { products: 10, ordersPerMonth: null, staff: 1, paymentGateways: 1 };
      const code = `COMM_${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, 30);
      await http.post('/api/v1/admin/plans').set(admin).send({ code, name: 'Comm', pricingModel: 'COMMISSION', monthlyPriceMinor: '100', annualPriceMinor: '0', commissionBps: 200, limits, features: {} }).expect(400);
      await http.post('/api/v1/admin/plans').set(admin).send({ code, name: 'Comm', pricingModel: 'COMMISSION', monthlyPriceMinor: null, annualPriceMinor: null, commissionBps: null, limits, features: {} }).expect(400);
      await http.post('/api/v1/admin/plans').set(admin).send({ code, name: 'Comm', pricingModel: 'COMMISSION', monthlyPriceMinor: null, annualPriceMinor: null, commissionBps: 10001, limits, features: {} }).expect(400);
      await http.post('/api/v1/admin/plans').set(admin).send({ code, name: 'Sub', monthlyPriceMinor: '100', annualPriceMinor: null, commissionBps: 200, limits, features: {} }).expect(400);
      const created = await http.post('/api/v1/admin/plans').set(admin)
        .send({ code, name: 'Comm', pricingModel: 'COMMISSION', monthlyPriceMinor: null, annualPriceMinor: null, commissionBps: 250, limits, features: {}, isPublic: false }).expect(201);
      expect(created.body).toMatchObject({ pricingModel: 'COMMISSION', commissionBps: 250, monthlyPriceMinor: '0', annualPriceMinor: '0' });
      const upd = await http.patch(`/api/v1/admin/plans/${created.body.id}`).set(admin).send({ commissionBps: 275 }).expect(200);
      expect(upd.body.commissionBps).toBe(275);

      const starter = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'STARTER' } });
      await http.patch(`/api/v1/admin/plans/${starter.id}`).set(admin).send({ pricingModel: 'COMMISSION', commissionBps: 300 }).expect(409); // sellers are on it
    });
  });

  // ───────────────────────── Sales contact ─────────────────────────
  describe('sales contact', () => {
    const inquiry = (over: Record<string, unknown> = {}) => ({
      fullName: 'Ngozi Okafor', email: `sales-${uniq()}@brand.ng`, businessName: 'Okafor Beauty Ltd', planInterest: 'ENTERPRISE',
      monthlyOrders: '5,000–20,000', message: 'We run three TikTok stores and need custom pricing.', ...over,
    });

    it('stores an enquiry from the public form; admins list and update it; sellers cannot', async () => {
      const body = inquiry();
      const r = await http.post('/api/v1/sales-inquiries').send(body).expect(202);
      expect(r.body).toMatchObject({ status: 'received' });
      expect(r.body.reference).toMatch(/^[0-9A-F]{8}$/);
      const row = await prisma.salesInquiry.findFirstOrThrow({ where: { email: body.email } });
      expect(row).toMatchObject({ status: 'NEW', businessName: 'Okafor Beauty Ltd', planInterest: 'ENTERPRISE' });

      const seller = await register();
      await http.get('/api/v1/admin/sales-inquiries').set({ Authorization: `Bearer ${seller.token}` }).expect(403);
      const admin = await platformAdmin();
      const list = await http.get('/api/v1/admin/sales-inquiries?status=NEW').set(admin).expect(200);
      expect(list.body.some((i: any) => i.id === row.id)).toBe(true);
      await http.patch(`/api/v1/admin/sales-inquiries/${row.id}`).set(admin).send({ status: 'CONTACTED', notes: 'Call booked Friday' }).expect(200);
      expect((await prisma.salesInquiry.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('CONTACTED');
      await http.patch(`/api/v1/admin/sales-inquiries/${randomUUID()}`).set(admin).send({ status: 'CLOSED' }).expect(404);
    });

    it('validates input and silently drops honeypot submissions', async () => {
      await http.post('/api/v1/sales-inquiries').send(inquiry({ email: 'not-an-email' })).expect(400);
      await http.post('/api/v1/sales-inquiries').send(inquiry({ message: 'short' })).expect(400);
      await http.post('/api/v1/sales-inquiries').send(inquiry({ phone: '0803' })).expect(400);
      await http.post('/api/v1/sales-inquiries').send(inquiry({ status: 'QUALIFIED' })).expect(400); // unknown field
      const bot = inquiry({ website: 'http://spam.example' });
      const r = await http.post('/api/v1/sales-inquiries').send(bot).expect(202);
      expect(r.body).toEqual({ status: 'received', reference: null });
      expect(await prisma.salesInquiry.count({ where: { email: bot.email as string } })).toBe(0);
    });
  });

  // ───────────────────────── Dashboard ─────────────────────────
  describe('seller dashboard', () => {
    async function seedSales(tenantId: string) {
      const db = prisma.forTenant(tenantId);
      const product = await db.product.create({ data: { name: 'Leather Bag', slug: 'leather-bag', productCode: 'BAG001', status: 'ACTIVE' } as any });
      const shoe = await db.product.create({ data: { name: 'Sneakers', slug: 'sneakers', productCode: 'SHOE002', status: 'ACTIVE' } as any });
      const bag = await db.productVariant.create({ data: { productId: product.id, sku: 'BAG001-BLK', name: 'Black', priceMinor: 2_500_000n, isDefault: true } as any });
      const sneaker = await db.productVariant.create({ data: { productId: shoe.id, sku: 'SHOE002-42', name: '42', priceMinor: 1_000_000n, isDefault: true } as any });
      await db.inventory.create({ data: { variantId: bag.id, onHand: 10, reserved: 2 } as any });
      await db.inventory.create({ data: { variantId: sneaker.id, onHand: 5, reserved: 0 } as any });
      const ada = await db.customer.create({ data: { fullName: 'Ada Obi', phone: phone() } as any });
      const ben = await db.customer.create({ data: { fullName: 'Ben Musa', phone: phone() } as any });

      let n = 0;
      const order = async (o: { status: any; paymentStatus: any; total: bigint; customerId?: string; items?: Array<[string, string, number, bigint]>; currency?: string }) => {
        n++;
        const created = await db.order.create({
          data: {
            reference: `LS-${uniq()}`, status: o.status, paymentStatus: o.paymentStatus, subtotalMinor: o.total, totalMinor: o.total,
            customerId: o.customerId, currency: o.currency ?? 'NGN',
          } as any,
        });
        for (const [variantId, name, qty, unit] of o.items ?? []) {
          await db.orderItem.create({ data: { orderId: created.id, variantId, productName: name, variantName: '-', sku: `S${n}`, quantity: qty, unitPriceMinor: unit, lineTotalMinor: unit * BigInt(qty) } as any });
        }
        return created;
      };
      const tx = (orderId: string | null, gross: bigint, status: any, verifiedAt: Date | null, extra: Record<string, unknown> = {}) =>
        db.paymentTransaction.create({
          data: { purpose: 'ORDER', orderId, provider: 'PAYSTACK', reference: `T-${uniq()}`, idempotencyKey: `K-${uniq()}`, currency: 'NGN', grossMinor: gross, status, verifiedAt, ...extra } as any,
        });

      const o1 = await order({ status: 'PAID', paymentStatus: 'PAID', total: 5_000_000n, customerId: ada.id, items: [[bag.id, 'Leather Bag', 2, 2_500_000n]] });
      const o2 = await order({ status: 'DELIVERED', paymentStatus: 'PAID', total: 3_000_000n, customerId: ben.id, items: [[sneaker.id, 'Sneakers', 3, 1_000_000n]] });
      await order({ status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', total: 2_500_000n, customerId: ada.id, items: [[bag.id, 'Leather Bag', 1, 2_500_000n]] });
      await order({ status: 'PAYMENT_VERIFICATION', paymentStatus: 'AWAITING_VERIFICATION', total: 1_000_000n });
      await order({ status: 'CANCELLED', paymentStatus: 'UNPAID', total: 1_000_000n });
      await order({ status: 'DRAFT', paymentStatus: 'UNPAID', total: 9_000_000n }); // excluded everywhere
      await order({ status: 'PAID', paymentStatus: 'PAID', total: 7_700n, currency: 'USD' }); // other currency: counted, not summed

      await tx(o1.id, 5_000_000n, 'SUCCEEDED', new Date()); // today
      await tx(o2.id, 3_000_000n, 'SUCCEEDED', new Date(Date.now() - 40 * DAY)); // outside this month
      await tx(null, 999_000n, 'FAILED', null);
      await tx(null, 123_000n, 'SUCCEEDED', new Date(), { purpose: 'SUBSCRIPTION' }); // SaaS revenue, never seller sales
      await tx(null, 7_700n, 'SUCCEEDED', new Date(), { currency: 'USD' });
      return { ada, ben };
    }

    it('a new workspace shows real zeros and empty lists', async () => {
      const a = await register();
      const s = (await http.get('/api/v1/dashboard/summary').set(a.h).expect(200)).body;
      expect(s).toMatchObject({
        currency: 'NGN', timezone: 'Africa/Lagos', salesTodayMinor: '0', salesThisMonthMinor: '0', totalOrders: 0, paidOrders: 0,
        pendingPayments: { count: 0, amountMinor: '0' }, cancelledOrders: 0, outstandingOrders: 0, productsSold: 0, availableInventory: 0,
        averageOrderValueMinor: '0', topProducts: [], recentCustomers: [], recentTransactions: [],
      });
      const c = (await http.get('/api/v1/dashboard/sales?period=daily').set(a.h).expect(200)).body;
      expect(c.points).toHaveLength(30);
      expect(c.points.every((p: any) => p.amountMinor === '0')).toBe(true);
    });

    it('computes every KPI from real rows, excludes other tenants, drafts, failed and SaaS payments', async () => {
      const a = await register();
      const b = await register();
      await seedSales(a.tenantId);
      await seedSales(b.tenantId); // must not leak into A
      const s = (await http.get('/api/v1/dashboard/summary').set(a.h).expect(200)).body;
      expect(s.salesTodayMinor).toBe('5000000');
      expect(s.salesThisMonthMinor).toBe('5000000');
      expect(s.totalOrders).toBe(6);
      expect(s.paidOrders).toBe(3);
      expect(s.pendingPayments).toEqual({ count: 2, amountMinor: '3500000' });
      expect(s.cancelledOrders).toBe(1);
      expect(s.outstandingOrders).toBe(2); // PAID NGN + PAID USD; DELIVERED is done
      expect(s.productsSold).toBe(5);
      expect(s.availableInventory).toBe(13);
      expect(s.averageOrderValueMinor).toBe('4000000'); // (50,000 + 30,000) / 2 in NGN
      expect(s.topProducts.map((p: any) => [p.productCode, p.quantity, p.revenueMinor])).toEqual([['SHOE002', '3', '3000000'], ['BAG001', '2', '5000000']]);
      expect(s.recentCustomers.map((c: any) => c.fullName).sort()).toEqual(['Ada Obi', 'Ben Musa']);
      expect(s.recentCustomers.find((c: any) => c.fullName === 'Ada Obi')).toMatchObject({ orderCount: 2, totalSpentMinor: '5000000' });
      expect(s.recentTransactions).toHaveLength(4); // ORDER purpose only (the SaaS one is excluded)

      const daily = (await http.get('/api/v1/dashboard/sales?period=daily').set(a.h).expect(200)).body;
      expect(daily.points[daily.points.length - 1].amountMinor).toBe('5000000');
      expect(daily.totalMinor).toBe('5000000');
      const monthly = (await http.get('/api/v1/dashboard/sales?period=monthly').set(a.h).expect(200)).body;
      expect(monthly.points).toHaveLength(12);
      expect(monthly.totalMinor).toBe('8000000');
      expect((await http.get('/api/v1/dashboard/sales?period=yearly').set(a.h).expect(200)).body.points).toHaveLength(5);
      expect((await http.get('/api/v1/dashboard/sales?period=weekly').set(a.h).expect(200)).body.points).toHaveLength(12);
      await http.get('/api/v1/dashboard/sales?period=hourly').set(a.h).expect(400);
    });

    it('requires reports:read', async () => {
      const a = await register();
      const staff = await register();
      const role = await prisma.role.findFirstOrThrow({ where: { tenantId: a.tenantId, key: 'SALES_ASSISTANT' } });
      const u = await prisma.user.findUniqueOrThrow({ where: { email: staff.body.email } });
      await prisma.tenantMember.create({ data: { tenantId: a.tenantId, userId: u.id, roleId: role.id } });
      await http.get('/api/v1/dashboard/summary').set({ Authorization: `Bearer ${staff.token}`, 'X-Tenant-Id': a.tenantId }).expect(403);
      await http.get('/api/v1/dashboard/summary').set({ Authorization: `Bearer ${staff.token}`, 'X-Tenant-Id': randomUUID() }).expect(403);
    });
  });
});
