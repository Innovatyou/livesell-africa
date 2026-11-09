import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { OrderNotifier } from '../src/automation/order-notifier.service';
import { configureApp } from '../src/configure-app';
import { PushMessage, PushProvider, PushReceipt, PushTicket } from '../src/push/push-provider';
import { PushService } from '../src/push/push.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingMailer } from './support';

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const token = () => `ExponentPushToken[${uniq()}${uniq()}]`;
type H = Record<string, string>;

class FakePush extends PushProvider {
  enabled = true;
  sent: PushMessage[] = [];
  gone = new Set<string>(); // tokens Expo says are no longer registered
  receiptErrors = new Set<string>();
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    this.sent.push(...messages);
    return messages.map((m) => (this.gone.has(m.to) ? { status: 'error', message: 'gone', error: 'DeviceNotRegistered' } : { status: 'ok', id: `tk-${m.to}-${uniq()}` }));
  }
  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    return Object.fromEntries(ids.map((id) => [id, [...this.receiptErrors].some((t) => id.startsWith(`tk-${t}`)) ? { status: 'error', error: 'DeviceNotRegistered' } : { status: 'ok' }]));
  }
}

describe('Mobile app backend — push notifications, offline-safe orders, mobile sessions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifier: OrderNotifier;
  let http: ReturnType<typeof request>;
  const push = new FakePush();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AuthMailer).useValue(new CapturingMailer()).overrideProvider(PushProvider).useValue(push).compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    notifier = app.get(OrderNotifier);
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `mob-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `mob-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: 'CorrectHorse42', acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').set('X-Client-Type', 'mobile').send(body).expect(201);
    return { body, res, slug: body.storeUsername, tenantId: res.body.tenant.id as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } as H, auth: { Authorization: `Bearer ${res.body.accessToken}` } as H };
  }
  async function member(tenantId: string, roleKey: string) {
    const other = await register();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId, key: roleKey } });
    const m = await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    await prisma.tenantMember.create({ data: { tenantId, userId: m.userId, roleId: role.id } });
    return { auth: other.auth, h: { ...other.auth, 'X-Tenant-Id': tenantId } };
  }
  async function store() {
    const s = await register();
    const bag = (await http.post('/api/v1/products').set(s.h).send({ name: 'Leather Bag', productCode: 'BAG001', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '2500000', initialStock: 5 }] }).expect(201)).body;
    await http.patch('/api/v1/store/profile').set(s.h).send({ description: 'Bags', whatsappNumber: '+2348031234567' }).expect(200);
    await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
    await http.post('/api/v1/payments/bank-accounts').set(s.h).send({ bankName: 'GTBank', accountNumber: '0123456789', accountName: 'ADA LTD' }).expect(201);
    return { ...s, variantId: bag.variants[0].id as string };
  }
  const drain = async () => { for (let i = 0; i < 20 && (await notifier.dispatchOutbox(200)).due >= 200; i++); };
  const pushesTo = (t: string) => push.sent.filter((m) => m.to === t);

  it('phones register with an Expo push token (validated); a phone that changes hands moves to the new user', async () => {
    const a = await register();
    await http.post('/api/v1/me/devices').set(a.auth).send({ token: 'not-a-token-at-all-really', platform: 'ios' }).expect(400);
    await http.post('/api/v1/me/devices').set(a.auth).send({ token: token(), platform: 'blackberry' }).expect(400);
    await http.post('/api/v1/me/devices').send({ token: token(), platform: 'ios' }).expect(401);
    const t = token();
    expect((await http.post('/api/v1/me/devices').set(a.auth).send({ token: t, platform: 'android', deviceName: 'Tecno Spark' }).expect(200)).body).toEqual({ registered: true, enabled: true });
    expect((await http.get('/api/v1/me/devices').set(a.auth).expect(200)).body).toEqual([expect.objectContaining({ platform: 'android', deviceName: 'Tecno Spark' })]);
    const b = await register();
    await http.post('/api/v1/me/devices').set(b.auth).send({ token: t, platform: 'android' }).expect(200);
    expect((await http.get('/api/v1/me/devices').set(a.auth).expect(200)).body).toEqual([]);
    expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: t } })).userId).not.toBe((await prisma.user.findUniqueOrThrow({ where: { email: a.body.email } })).id);
  });

  it('new online and WhatsApp-style orders push to the team; staff-entered orders don’t; transfer reports push only to people who can verify', async () => {
    const s = await store();
    const ownerT = token();
    await http.post('/api/v1/me/devices').set(s.auth).send({ token: ownerT, platform: 'ios' }).expect(200);
    const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
    const assistantT = token();
    await http.post('/api/v1/me/devices').set(assistant.auth).send({ token: assistantT, platform: 'android' }).expect(200);
    const outsider = await register();
    const outsiderT = token();
    await http.post('/api/v1/me/devices').set(outsider.auth).send({ token: outsiderT, platform: 'android' }).expect(200);

    const r = (await http.post(`/api/v1/store/${s.slug}/checkout`).send({ customer: { fullName: 'Amaka Nnaji', phone: phone() }, items: [{ variantId: s.variantId, quantity: 1 }], shippingAddress: { line1: '1 Road', city: 'Ikeja', state: 'Lagos' } }).expect(201)).body;
    const o = await prisma.order.findFirstOrThrow({ where: { reference: r.reference } });
    await drain();
    expect(pushesTo(ownerT)).toEqual([expect.objectContaining({ title: `New order ${r.reference}`, body: 'Amaka Nnaji · ₦25,000 · online store', channelId: 'orders', priority: 'high', data: expect.objectContaining({ type: 'new_order', orderId: o.id, tenantId: s.tenantId }) })]);
    expect(pushesTo(assistantT)).toHaveLength(1);
    expect(pushesTo(outsiderT)).toHaveLength(0); // other stores' people never hear about this order
    await drain();
    expect(pushesTo(ownerT)).toHaveLength(1); // once per event

    await http.post('/api/v1/orders').set(s.h).send({ customer: { fullName: 'Walk-in', phone: phone() }, items: [{ variantId: s.variantId, quantity: 1 }] }).expect(201);
    await drain();
    expect(pushesTo(ownerT)).toHaveLength(1);

    await http.post(`/api/v1/store/${s.slug}/orders/${r.reference}/transfer`).send({ token: r.trackingToken, payerName: 'Amaka', payerBank: 'Access', payerReference: `0000${uniq()}` }).expect(200);
    await drain();
    expect(pushesTo(ownerT).at(-1)).toMatchObject({ title: `Transfer to check · ${r.reference}`, data: expect.objectContaining({ type: 'transfer_reported', orderId: o.id }) });
    expect(pushesTo(assistantT)).toHaveLength(1); // assistants can't verify transfers
  });

  it('phones Expo reports as gone are switched off (on send and from receipts); signing out stops pushes', async () => {
    const s = await store();
    const goneNow = token();
    const goneLater = token();
    const keep = token();
    for (const t of [goneNow, goneLater, keep]) await http.post('/api/v1/me/devices').set(s.auth).send({ token: t, platform: 'android' }).expect(200);
    push.gone.add(goneNow);
    push.receiptErrors.add(goneLater);
    const checkout = () => http.post(`/api/v1/store/${s.slug}/checkout`).send({ customer: { fullName: 'Bola', phone: phone() }, items: [{ variantId: s.variantId, quantity: 1 }], shippingAddress: { line1: '1 Road', city: 'Ikeja', state: 'Lagos' } }).expect(201);
    await checkout();
    await drain();
    expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: goneNow } })).disabledAt).not.toBeNull();
    const svc = app.get(PushService);
    await svc.checkReceipts(new Date(Date.now() + 16 * 60_000));
    expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: goneLater } })).disabledAt).not.toBeNull();
    expect((await prisma.deviceToken.findUniqueOrThrow({ where: { token: keep } })).disabledAt).toBeNull();
    await http.delete('/api/v1/me/devices').set(s.auth).send({ token: keep }).expect(200);
    const before = push.sent.length;
    await checkout();
    await drain();
    expect(push.sent.slice(before).filter((m) => [goneNow, goneLater, keep].includes(m.to))).toHaveLength(0);
  });

  it('offline-safe orders: the same clientRef twice gives one order and one stock hold; refs are per store', async () => {
    const s = await store();
    const body = { customer: { fullName: 'Chidi', phone: phone() }, items: [{ productCode: 'BAG001', quantity: 2 }], clientRef: `m-${uniq()}` };
    const a = (await http.post('/api/v1/orders').set(s.h).send(body).expect(201)).body;
    const b = (await http.post('/api/v1/orders').set(s.h).send(body).expect(201)).body;
    expect(b.id).toBe(a.id);
    expect(await prisma.order.count({ where: { tenantId: s.tenantId, clientRef: body.clientRef } })).toBe(1);
    expect((await prisma.inventory.findUniqueOrThrow({ where: { variantId: s.variantId } })).reserved).toBe(2);
    const [x, y] = await Promise.all([1, 2].map(() => http.post('/api/v1/orders').set(s.h).send({ ...body, items: [{ productCode: 'BAG001', quantity: 1 }], clientRef: `m-${uniq()}race`.slice(0, 40) })));
    expect([x.status, y.status]).toEqual([201, 201]);
    const raced = { ...body, items: [{ productCode: 'BAG001', quantity: 1 }], clientRef: `m-${uniq()}` };
    const [p, q] = await Promise.all([1, 2].map(() => http.post('/api/v1/orders').set(s.h).send(raced)));
    expect(p.body.id).toBe(q.body.id);
    await http.post('/api/v1/orders').set(s.h).send({ ...body, clientRef: 'bad ref!' }).expect(400);
    const other = await store();
    const c = (await http.post('/api/v1/orders').set(other.h).send(body).expect(201)).body;
    expect(c.id).not.toBe(a.id);
  });

  it('mobile sessions: refresh token in the body, rotated, revoked on logout', async () => {
    const a = await register();
    expect(a.res.body.refreshToken).toEqual(expect.any(String));
    const r1 = a.res.body.refreshToken as string;
    const refreshed = (await http.post('/api/v1/auth/refresh').set('X-Client-Type', 'mobile').send({ refreshToken: r1 }).expect(200)).body;
    expect(refreshed.refreshToken).toEqual(expect.any(String));
    expect(refreshed.refreshToken).not.toBe(r1);
    await http.post('/api/v1/auth/logout').set('X-Client-Type', 'mobile').send({ refreshToken: refreshed.refreshToken }).expect(204);
    await http.post('/api/v1/auth/refresh').set('X-Client-Type', 'mobile').send({ refreshToken: refreshed.refreshToken }).expect(401);
  });
});
