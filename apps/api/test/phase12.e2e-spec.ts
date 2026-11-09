import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingMailer } from './support';

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

/** MASTER-SPEC §23 security checks over the real HTTP pipeline (§26 "security tests"). */
describe('Phase 12 — security', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AuthMailer).useValue(new CapturingMailer()).compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p12-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p12-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: 'CorrectHorse42', acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { body, res, tenantId: res.body.tenant.id as string, token: res.body.accessToken as string };
  }

  it('security headers and a request id on every response; client request ids are kept only when well-formed', async () => {
    const r = await http.get('/health/live').expect(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeDefined();
    expect(r.headers['content-security-policy']).toBeDefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((await http.get('/health/live').set('X-Request-Id', 'abc-12345678').expect(200)).headers['x-request-id']).toBe('abc-12345678');
    expect((await http.get('/health/live').set('X-Request-Id', '<script>').expect(200)).headers['x-request-id']).not.toBe('<script>');
  });

  it('CORS allows only configured origins', async () => {
    const bad = await http.options('/api/v1/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await http.options('/api/v1/auth/login').set('Origin', 'http://localhost:3000').set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('passwords are argon2id hashes; the refresh token lives only in an httpOnly, SameSite=Strict cookie scoped to /api/v1/auth', async () => {
    const a = await register();
    const user = await prisma.user.findUniqueOrThrow({ where: { email: a.body.email } });
    expect(JSON.stringify(user)).not.toContain('CorrectHorse42');
    expect(Object.values(user).some((v) => typeof v === 'string' && v.startsWith('$argon2id$'))).toBe(true);
    const cookie = ([] as string[]).concat(a.res.headers['set-cookie'] ?? []).join(';');
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(a.res.body.refreshToken).toBeUndefined(); // web clients never see it
  });

  it('tampered or missing tokens are refused; another store’s tenant header is refused', async () => {
    const a = await register();
    const b = await register();
    const [h, p, s] = a.token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), platformRole: 'PLATFORM_ADMIN' })).toString('base64url')}.${s}`;
    await http.get('/api/v1/admin/overview').set('Authorization', `Bearer ${forged}`).expect(401);
    await http.get('/api/v1/products').set('X-Tenant-Id', a.tenantId).expect(401);
    await http.get('/api/v1/products').set({ Authorization: `Bearer ${a.token}`, 'X-Tenant-Id': b.tenantId }).expect(403);
    await http.get('/api/v1/admin/overview').set('Authorization', `Bearer ${a.token}`).expect(403);
  });

  it('input is validated strictly; injection-shaped input is just data; oversized bodies are refused', async () => {
    const a = await register();
    const H = { Authorization: `Bearer ${a.token}`, 'X-Tenant-Id': a.tenantId };
    await http.post('/api/v1/products').set(H).send({ name: 'Bag', productCode: 'BAG001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '100', initialStock: 1 }], tenantId: 'x' }).expect(400);
    await http.post('/api/v1/products').set(H).send({ name: 'Bag', productCode: 'BAG001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '1.5', initialStock: 1 }] }).expect(400); // money: whole kobo only
    expect((await http.get(`/api/v1/orders?search=${encodeURIComponent("' OR 1=1; DROP TABLE orders; --")}`).set(H).expect(200)).body.items).toEqual([]);
    expect((await http.get(`/api/v1/customers?search=${encodeURIComponent("%' UNION SELECT * FROM users --")}`).set(H).expect(200)).body.items).toEqual([]);
    expect(await prisma.order.count()).toBeGreaterThanOrEqual(0); // table still there
    const huge = JSON.stringify({ name: 'x'.repeat(4 * 1024 * 1024) });
    await http.post('/api/v1/products').set(H).set('Content-Type', 'application/json').send(huge).expect(413);
  });

  it('errors never leak stack traces or internals', async () => {
    const r = await http.get('/api/v1/orders/not-a-uuid').set('Authorization', 'Bearer x').expect(401);
    expect(JSON.stringify(r.body)).not.toMatch(/at \w+ \(|node_modules|prisma/i);
    const a = await register();
    const nf = await http.get('/api/v1/orders/00000000-0000-0000-0000-000000000000').set({ Authorization: `Bearer ${a.token}`, 'X-Tenant-Id': a.tenantId }).expect(404);
    expect(JSON.stringify(nf.body)).not.toMatch(/stack|prisma|SELECT/i);
  });
});
