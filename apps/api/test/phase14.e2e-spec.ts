import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { configureApp } from '../src/configure-app';
import { OrdersService } from '../src/orders/orders.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer } from './support';

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
type H = Record<string, string>;

describe('Phase 14 — pre-orders (selling beyond stock) and smart product codes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer).useValue(new CapturingMailer())
      .overrideProvider(BillingNotifier).useValue(new CapturingBillingNotifier())
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    orders = app.get(OrdersService);
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  async function store(stock: number) {
    const u = uniq();
    const res = await http.post('/api/v1/auth/register').send({
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p14-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p14-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: 'CorrectHorse42', acceptTerms: true, acceptPrivacy: true,
    }).expect(201);
    const h: H = { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id };
    const p = (await http.post('/api/v1/products').set(h).send({ name: 'Red Leather Handbag', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '2500000', initialStock: stock }] }).expect(201)).body;
    return { h, tenantId: res.body.tenant.id as string, slug: `p14-${u}`.slice(0, 40), product: p, variantId: p.variants[0].id as string };
  }
  const inv = (variantId: string) => prisma.inventory.findUniqueOrThrow({ where: { variantId } });
  const order = (h: H, variantId: string, quantity: number) => http.post('/api/v1/orders').set(h).send({ items: [{ variantId, quantity }] });
  const items = (orderId: string) => prisma.orderItem.findMany({ where: { orderId }, select: { quantity: true, backorderedQty: true } });
  const move = (h: H, id: string, status: string) => http.post(`/api/v1/orders/${id}/status`).set(h).send({ status });

  it('product codes come from what the product is (Red Leather Handbag → BAG001)', async () => {
    const s = await store(1);
    expect(s.product.productCode).toBe('BAG001');
    const sug = await http.get('/api/v1/products/code-suggestion?name=Ladies%20Block%20Heels%20Size%2039').set(s.h).expect(200);
    expect(sug.body.productCode).toBe('HEEL002');
  });

  it('off by default: ordering more than the stock is refused, as before', async () => {
    const s = await store(1);
    const r = await order(s.h, s.variantId, 3).expect(409);
    expect(r.body.code).toBe('INSUFFICIENT_STOCK');
    expect(await inv(s.variantId)).toMatchObject({ onHand: 1, reserved: 0 });
  });

  it('pre-orders: holds what exists, records the rest, fills oldest-first on restock, blocks dispatch until filled', async () => {
    const s = await store(1);
    const profile = await http.patch('/api/v1/store/profile').set(s.h).send({ allowPreorders: true }).expect(200);
    expect(profile.body.storefront.allowPreorders).toBe(true);

    const a = (await order(s.h, s.variantId, 3).expect(201)).body; // 1 held, 2 waiting
    const b = (await order(s.h, s.variantId, 2).expect(201)).body; // 0 held, 2 waiting
    expect(await items(a.id)).toEqual([{ quantity: 3, backorderedQty: 2 }]);
    expect(await items(b.id)).toEqual([{ quantity: 2, backorderedQty: 2 }]);
    expect(await inv(s.variantId)).toMatchObject({ onHand: 1, reserved: 1 }); // the DB rule reserved ≤ on hand still holds

    // The online store shows it as a pre-order, not sold out.
    await http.patch('/api/v1/storefront').set(s.h).send({ isPublished: true });
    await prisma.storefrontSettings.updateMany({ where: { tenantId: s.tenantId }, data: { isPublished: true } });
    const pub = await http.get(`/api/v1/store/${s.slug}/products`).expect(200);
    expect(pub.body.items[0].availability).toBe('preorder');

    await orders.markPaid(s.tenantId, a.id, { verifiedBy: 'test' });
    const blocked = await move(s.h, a.id, 'DISPATCHED').expect(409);
    expect(blocked.body.code).toBe('AWAITING_STOCK');

    // Restock 3: order A (older) gets its 2 first, then B gets 1.
    await http.post(`/api/v1/inventory/variants/${s.variantId}/adjust`).set(s.h).send({ mode: 'add', quantity: 3, reason: 'Supplier delivery' }).expect(201);
    expect(await items(a.id)).toEqual([{ quantity: 3, backorderedQty: 0 }]);
    expect(await items(b.id)).toEqual([{ quantity: 2, backorderedQty: 1 }]);
    expect(await inv(s.variantId)).toMatchObject({ onHand: 4, reserved: 4 });

    await move(s.h, a.id, 'DISPATCHED').expect(200);
    expect(await inv(s.variantId)).toMatchObject({ onHand: 1, reserved: 1 }); // A's 3 sold; B still holds 1

    // Cancelling B releases only what B held (1) — and never another order's stock.
    await move(s.h, b.id, 'CANCELLED').expect(200);
    expect(await inv(s.variantId)).toMatchObject({ onHand: 1, reserved: 0 });
  });

  it('a cancelled order’s stock goes to the next pre-order waiting, not back to the shelf', async () => {
    const s = await store(2);
    await http.patch('/api/v1/store/profile').set(s.h).send({ allowPreorders: true }).expect(200);
    const a = (await order(s.h, s.variantId, 2).expect(201)).body; // holds both
    const b = (await order(s.h, s.variantId, 1).expect(201)).body; // waits
    expect(await items(b.id)).toEqual([{ quantity: 1, backorderedQty: 1 }]);
    await move(s.h, a.id, 'CANCELLED').expect(200);
    expect(await items(b.id)).toEqual([{ quantity: 1, backorderedQty: 0 }]);
    expect(await inv(s.variantId)).toMatchObject({ onHand: 2, reserved: 1 });
  });
});
