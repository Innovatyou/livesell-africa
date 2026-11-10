import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingMailer } from './support';

const PASSWORD = 'CorrectHorse42';
let seq = 0;
const seller = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    businessName: `Shop ${seq}`, ownerFullName: `Owner ${seq}`, email: `owner${seq}-${Date.now()}@example.com`,
    phone: `+23480${String(10_000_000 + seq * 7919 + (Date.now() % 1000)).slice(0, 8)}`,
    country: 'NG', state: 'Lagos', city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion',
    storeUsername: `shop-${seq}-${Date.now() % 100000}`, businessType: 'INDIVIDUAL', password: PASSWORD,
    acceptTerms: true, acceptPrivacy: true, ...over,
  };
};
const refreshCookie = (res: request.Response) =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ls_rt='))!.split(';')[0];

describe('Phase 1 — auth, multi-tenancy, RBAC, integrity', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const mailer = new CapturingMailer();
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AuthMailer).useValue(mailer).compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  async function register(over: Record<string, unknown> = {}) {
    const body = seller(over);
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { body, res, token: res.body.accessToken as string, tenantId: res.body.tenant.id as string, cookie: refreshCookie(res) };
  }

  // ── Registration ──
  describe('registration', () => {
    it('creates user, workspace, the system roles, owner membership, channels and a trial', async () => {
      const { res, tenantId } = await register();
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeUndefined(); // web: cookie only
      const cookie = ([] as string[]).concat(res.headers['set-cookie']).find((c) => c.startsWith('ls_rt='))!;
      expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/SameSite=Strict/); expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

      const roles = await prisma.role.findMany({ where: { tenantId }, select: { key: true } });
      expect(roles.map((r) => r.key).sort()).toEqual(['ACCOUNTANT', 'CUSTOMER_CARE', 'DISPATCHER', 'LIVE_MODERATOR', 'OWNER', 'SALES_ASSISTANT', 'STORE_MANAGER']);
      expect(await prisma.salesChannel.count({ where: { tenantId } })).toBe(2);
      const sub = await prisma.subscription.findFirstOrThrow({ where: { tenantId }, include: { plan: true } });
      expect(sub.status).toBe('TRIALING');
      expect(sub.plan.code).toBe('STARTER');
      expect(sub.plan.monthlyPriceMinor).toBe(500_000n); // ₦5,000 in kobo
    });

    it('rejects duplicate username, reserved username, bad input and unknown fields', async () => {
      const { body } = await register();
      await http.post('/api/v1/auth/register').send(seller({ storeUsername: body.storeUsername })).expect(409);
      await http.post('/api/v1/auth/register').send(seller({ email: body.email })).expect(409);
      await http.post('/api/v1/auth/register').send(seller({ storeUsername: 'admin' })).expect(409);
      await http.post('/api/v1/auth/register').send(seller({ phone: '08012345678' })).expect(400);
      await http.post('/api/v1/auth/register').send(seller({ acceptTerms: false })).expect(400);
      await http.post('/api/v1/auth/register').send(seller({ password: 'short' })).expect(400);
      await http.post('/api/v1/auth/register').send(seller({ platformRole: 'PLATFORM_ADMIN' })).expect(400);
    });

    it('verifies email with a single-use token', async () => {
      const { body } = await register();
      const token = mailer.verify.get(body.email)!;
      await http.post('/api/v1/auth/verify-email').send({ token }).expect(204);
      await http.post('/api/v1/auth/verify-email').send({ token }).expect(400);
      expect((await prisma.user.findUniqueOrThrow({ where: { email: body.email } })).status).toBe('ACTIVE');
    });
  });

  // ── Login & sessions ──
  describe('login and refresh rotation', () => {
    it('rejects wrong password and unknown email identically', async () => {
      const { body } = await register();
      const a = await http.post('/api/v1/auth/login').send({ email: body.email, password: 'WrongPass99' }).expect(401);
      const b = await http.post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'WrongPass99' }).expect(401);
      expect(a.body.message).toEqual(b.body.message);
      await http.post('/api/v1/auth/login').send({ email: body.email, password: PASSWORD }).expect(200);
    });

    it('rotates refresh tokens and revokes the whole family when an old token is replayed', async () => {
      const { cookie: first } = await register();
      const r1 = await http.post('/api/v1/auth/refresh').set('Cookie', first).expect(200);
      const second = refreshCookie(r1);
      expect(second).not.toEqual(first);

      // Attacker replays the first (now-revoked) token.
      await http.post('/api/v1/auth/refresh').set('Cookie', first).expect(401);
      // The legitimate holder's newer token is now dead too — forced re-login.
      await http.post('/api/v1/auth/refresh').set('Cookie', second).expect(401);
    });

    it('allows only one of two concurrent refreshes with the same token', async () => {
      const { cookie } = await register();
      const results = await Promise.all([1, 2].map(() => http.post('/api/v1/auth/refresh').set('Cookie', cookie)));
      expect(results.map((r) => r.status).filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    });

    it('returns refresh token in body only for mobile clients', async () => {
      const { body } = await register();
      const res = await http.post('/api/v1/auth/login').set('X-Client-Type', 'mobile').send({ email: body.email, password: PASSWORD }).expect(200);
      expect(res.body.refreshToken).toBeDefined();
      await http.post('/api/v1/auth/refresh').send({ refreshToken: res.body.refreshToken }).expect(200);
    });

    it('logout revokes the session', async () => {
      const { cookie } = await register();
      await http.post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
      await http.post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it('password reset is enumeration-safe, single-use, and signs out all devices', async () => {
      const { body, cookie } = await register();
      await http.post('/api/v1/auth/forgot-password').send({ email: 'ghost@example.com' }).expect(202);
      await http.post('/api/v1/auth/forgot-password').send({ email: body.email }).expect(202);
      const token = mailer.reset.get(body.email)!;
      await http.post('/api/v1/auth/reset-password').send({ token, newPassword: 'BrandNewPass77' }).expect(204);
      await http.post('/api/v1/auth/reset-password').send({ token, newPassword: 'AnotherPass88' }).expect(400);
      await http.post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
      await http.post('/api/v1/auth/login').send({ email: body.email, password: PASSWORD }).expect(401);
      await http.post('/api/v1/auth/login').send({ email: body.email, password: 'BrandNewPass77' }).expect(200);
    });

    it('suspension takes effect immediately, even with a valid access token', async () => {
      const { body, token, tenantId } = await register();
      await http.get('/api/v1/workspace').set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', tenantId).expect(200);
      await prisma.user.update({ where: { email: body.email }, data: { status: 'SUSPENDED' } });
      await http.get('/api/v1/workspace').set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', tenantId).expect(401);
    });

    it('rejects tampered and unauthenticated requests', async () => {
      const { token } = await register();
      await http.get('/api/v1/auth/me').expect(401);
      await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token.slice(0, -2)}xx`).expect(401);
      const me = await http.get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
      expect(me.body.memberships).toHaveLength(1);
      expect(me.body.passwordHash).toBeUndefined();
    });
  });

  // ── Tenant isolation ──
  describe('tenant isolation', () => {
    it("a seller cannot access another seller's workspace by changing X-Tenant-Id", async () => {
      const a = await register();
      const b = await register();
      const auth = { Authorization: `Bearer ${a.token}` };
      await http.get('/api/v1/workspace').set(auth).set('X-Tenant-Id', a.tenantId).expect(200);
      const cross = await http.get('/api/v1/workspace').set(auth).set('X-Tenant-Id', b.tenantId).expect(403);
      const ghost = await http.get('/api/v1/workspace').set(auth).set('X-Tenant-Id', randomUUID()).expect(403);
      expect(cross.body.message).toEqual(ghost.body.message); // no tenant enumeration
      await http.get('/api/v1/workspace').set(auth).expect(403);
      await http.get('/api/v1/workspace').set(auth).set('X-Tenant-Id', "' OR 1=1 --").expect(403);
      await http.get('/api/v1/workspace/members').set(auth).set('X-Tenant-Id', b.tenantId).expect(403);
    });

    it('the tenant-scoped client cannot read or write other tenants, even when asked to', async () => {
      const a = await register();
      const b = await register();
      const scopedA = prisma.forTenant(a.tenantId);
      const leaked = await scopedA.tenantMember.findMany({ where: { tenantId: b.tenantId } });
      expect(leaked.every((m) => m.tenantId === a.tenantId)).toBe(true);
      const bRole = await prisma.role.findFirstOrThrow({ where: { tenantId: b.tenantId, key: 'OWNER' } });
      expect(await scopedA.role.findUnique({ where: { id: bRole.id } })).toBeNull();
      const upd = await scopedA.role.updateMany({ where: { id: bRole.id }, data: { name: 'pwned' } });
      expect(upd.count).toBe(0);
      await expect(scopedA.salesChannel.create({ data: { tenantId: b.tenantId, type: 'OTHER', name: 'x' } as any })).rejects.toThrow(/cross-tenant/);
    });

    it('suspended workspaces are blocked for their own members', async () => {
      const a = await register();
      await prisma.tenant.update({ where: { id: a.tenantId }, data: { status: 'SUSPENDED' } });
      await http.get('/api/v1/workspace').set('Authorization', `Bearer ${a.token}`).set('X-Tenant-Id', a.tenantId).expect(403);
    });
  });

  // ── RBAC ──
  describe('role-based permissions', () => {
    it('sales assistant can view workspace but not staff list or audit log', async () => {
      const owner = await register();
      const staff = await register();
      const role = await prisma.role.findFirstOrThrow({ where: { tenantId: owner.tenantId, key: 'SALES_ASSISTANT' } });
      const staffUser = await prisma.user.findUniqueOrThrow({ where: { email: staff.body.email as string } });
      await prisma.tenantMember.create({ data: { tenantId: owner.tenantId, userId: staffUser.id, roleId: role.id } });

      const h = { Authorization: `Bearer ${staff.token}`, 'X-Tenant-Id': owner.tenantId };
      const ws = await http.get('/api/v1/workspace').set(h).expect(200);
      expect(ws.body.role).toBe('SALES_ASSISTANT');
      expect(ws.body.permissions).toContain('orders:create');
      expect(ws.body.permissions).not.toContain('payments:refund');
      await http.get('/api/v1/workspace/members').set(h).expect(403);
      await http.get('/api/v1/workspace/audit-logs').set(h).expect(403);

      const oh = { Authorization: `Bearer ${owner.token}`, 'X-Tenant-Id': owner.tenantId };
      const members = await http.get('/api/v1/workspace/members').set(oh).expect(200);
      expect(members.body).toHaveLength(2);
    });

    it('disabled members lose access', async () => {
      const owner = await register();
      const staff = await register();
      const role = await prisma.role.findFirstOrThrow({ where: { tenantId: owner.tenantId, key: 'LIVE_MODERATOR' } });
      const u = await prisma.user.findUniqueOrThrow({ where: { email: staff.body.email as string } });
      await prisma.tenantMember.create({ data: { tenantId: owner.tenantId, userId: u.id, roleId: role.id, status: 'DISABLED' } });
      await http.get('/api/v1/workspace').set({ Authorization: `Bearer ${staff.token}`, 'X-Tenant-Id': owner.tenantId }).expect(403);
    });
  });

  // ── Audit ──
  it('writes audit events with secrets redacted', async () => {
    const { body, tenantId, token } = await register();
    await http.post('/api/v1/auth/login').send({ email: body.email, password: 'WrongPass99' }).expect(401);
    const logs = await http.get('/api/v1/workspace/audit-logs').set({ Authorization: `Bearer ${token}`, 'X-Tenant-Id': tenantId }).expect(200);
    expect(logs.body.map((l: any) => l.action)).toContain('auth.register');
    const failed = await prisma.auditLog.findFirstOrThrow({ where: { action: 'auth.login_failed', metadata: { path: ['email'], equals: body.email } } });
    expect(JSON.stringify(failed.metadata)).not.toContain('WrongPass99');
  });

  // ── Database-level financial integrity ──
  describe('database integrity constraints', () => {
    it('inventory cannot go negative or reserve more than on hand', async () => {
      const { tenantId } = await register();
      const db = prisma.forTenant(tenantId);
      const product = await db.product.create({ data: { name: 'Leather Bag', slug: 'leather-bag', productCode: 'BAG001' } as any });
      const variant = await db.productVariant.create({ data: { productId: product.id, sku: 'BAG001-BLK', name: 'Black', priceMinor: 2_500_000n } as any });
      const inv = await db.inventory.create({ data: { variantId: variant.id, onHand: 1 } as any });
      await expect(db.inventory.update({ where: { id: inv.id }, data: { reserved: 2 } })).rejects.toThrow();
      await expect(db.inventory.update({ where: { id: inv.id }, data: { onHand: -1 } })).rejects.toThrow();
      await expect(db.productVariant.create({ data: { productId: product.id, sku: 'X', name: 'x', priceMinor: -1n } as any })).rejects.toThrow();
      await expect(db.product.create({ data: { name: 'Dup', slug: 'dup', productCode: 'BAG001' } as any })).rejects.toThrow(); // codes unique per tenant
    });

    it('ledger journals must balance and entries are append-only', async () => {
      const acct = await prisma.ledgerAccount.create({ data: { code: `TEST_${Date.now()}`, type: 'ASSET', currency: 'NGN' } });
      const rev = await prisma.ledgerAccount.create({ data: { code: `REV_${Date.now()}`, type: 'REVENUE', currency: 'NGN' } });
      const bad = randomUUID();
      await expect(prisma.$transaction([
        prisma.ledgerEntry.create({ data: { journalId: bad, accountId: acct.id, direction: 'DEBIT', amountMinor: 1000n, currency: 'NGN' } }),
        prisma.ledgerEntry.create({ data: { journalId: bad, accountId: rev.id, direction: 'CREDIT', amountMinor: 999n, currency: 'NGN' } }),
      ])).rejects.toThrow(/unbalanced/);

      const good = randomUUID();
      await prisma.$transaction([
        prisma.ledgerEntry.create({ data: { journalId: good, accountId: acct.id, direction: 'DEBIT', amountMinor: 1000n, currency: 'NGN' } }),
        prisma.ledgerEntry.create({ data: { journalId: good, accountId: rev.id, direction: 'CREDIT', amountMinor: 1000n, currency: 'NGN' } }),
      ]);
      await expect(prisma.ledgerEntry.updateMany({ where: { journalId: good }, data: { amountMinor: 1n } })).rejects.toThrow(/append-only/);
    });

    it('duplicate provider webhooks are rejected at the database', async () => {
      const ev = { provider: 'PAYSTACK' as const, eventId: `evt_${Date.now()}`, eventType: 'charge.success', signatureValid: true, payload: {} };
      await prisma.paymentWebhookEvent.create({ data: ev });
      await expect(prisma.paymentWebhookEvent.create({ data: ev })).rejects.toThrow();
    });
  });

  it('health endpoints report dependencies', async () => {
    await http.get('/health/live').expect(200);
    const r = await http.get('/health/ready').expect(200);
    expect(r.body.checks).toEqual({ database: 'up', redis: 'up' });
  });
});
