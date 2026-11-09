import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthMailer } from '../src/auth/auth-mailer';
import { BillingNotifier } from '../src/billing/billing-notifier';
import { configureApp } from '../src/configure-app';
import { InsufficientStockError, InventoryService } from '../src/inventory/inventory.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { CapturingBillingNotifier, CapturingMailer } from './support';

const PASSWORD = 'CorrectHorse42';
const DAY = 86_400_000;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const phone = () => `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), Buffer.alloc(300, 3)]);
const simple = (price = '2500000', initialStock = 5) => [{ attributes: {}, priceMinor: price, initialStock }];

describe('Phase 3 — products, inventory, storefront, customers', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let inventory: InventoryService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthMailer).useValue(new CapturingMailer())
      .overrideProvider(BillingNotifier).useValue(new CapturingBillingNotifier())
      .compile();
    app = configureApp(mod.createNestApplication());
    await app.init();
    prisma = app.get(PrismaService);
    inventory = app.get(InventoryService);
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  async function register() {
    const u = uniq();
    const body = {
      businessName: `Shop ${u}`, ownerFullName: `Owner ${u}`, email: `p3-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos',
      city: 'Ikeja', businessAddress: '12 Allen Avenue', businessCategory: 'Fashion', storeUsername: `p3-${u}`.slice(0, 40),
      businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true,
    };
    const res = await http.post('/api/v1/auth/register').send(body).expect(201);
    return { body, slug: body.storeUsername, tenantId: res.body.tenant.id as string, token: res.body.accessToken as string, h: { Authorization: `Bearer ${res.body.accessToken}`, 'X-Tenant-Id': res.body.tenant.id } };
  }
  async function member(ownerTenantId: string, roleKey: string) {
    const other = await register();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId: ownerTenantId, key: roleKey } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: other.body.email } });
    await prisma.tenantMember.create({ data: { tenantId: ownerTenantId, userId: user.id, roleId: role.id } });
    return { Authorization: `Bearer ${other.token}`, 'X-Tenant-Id': ownerTenantId };
  }
  const create = (h: Record<string, string>, body: object) => http.post('/api/v1/products').set(h).send(body);
  const variantOf = async (h: Record<string, string>, productId: string, i = 0) => (await http.get(`/api/v1/products/${productId}`).set(h).expect(200)).body.variants[i];
  async function upload(h: Record<string, string>, path: string, buf: Buffer, contentType: string) {
    const p = await http.post(path).set(h).send({ contentType, contentLength: buf.length }).expect(201);
    expect((await fetch(p.body.uploadUrl, { method: 'PUT', body: buf, headers: { 'Content-Type': contentType } })).status).toBe(200);
    return p.body.key as string;
  }

  // ───────────────────────── Products ─────────────────────────
  describe('products and variants', () => {
    it('creates a simple product with a generated code, slug, default variant and opening stock movement', async () => {
      const a = await register();
      const r = await create(a.h, { name: 'Premium Leather Bag', variants: simple('2500000', 7), status: 'ACTIVE' }).expect(201);
      expect(r.body).toMatchObject({ productCode: 'BAG001', slug: 'premium-leather-bag', status: 'ACTIVE' });
      expect(r.body.variants).toHaveLength(1);
      expect(r.body.variants[0]).toMatchObject({ sku: 'BAG001', name: 'Default', isDefault: true, priceMinor: '2500000', inventory: { onHand: 7, reserved: 0, available: 7 } });
      const moves = (await http.get(`/api/v1/inventory/movements?productId=${r.body.id}`).set(a.h).expect(200)).body;
      expect(moves).toEqual([expect.objectContaining({ type: 'RESTOCK', quantity: 7, reason: 'Opening stock', onHandAfter: 7, reservedAfter: 0 })]);

      const second = await create(a.h, { name: "Men's Sneakers", variants: simple('1850000', 0) }).expect(201);
      expect(second.body.productCode).toBe('SNEAK002'); // numbers never repeat across prefixes
      const sug = await http.get('/api/v1/products/code-suggestion?name=Evening%20Dress').set(a.h).expect(200);
      expect(sug.body.productCode).toBe('DRESS003');
      expect((await http.get('/api/v1/products/by-code/bag001').set(a.h).expect(200)).body.id).toBe(r.body.id);
    });

    it('creates a variant matrix with unique SKUs and validates variants, codes and prices', async () => {
      const a = await register();
      const variants = ['Black', 'Brown'].flatMap((c) => ['M', 'L'].map((s) => ({ attributes: { Colour: c, Size: s }, priceMinor: '1500000', initialStock: 2 })));
      const r = await create(a.h, { name: 'Ankara Two-Piece', productCode: 'ank004', variants, tags: ['Ankara', 'ankara', 'New '] }).expect(201);
      expect(r.body.productCode).toBe('ANK004');
      expect(r.body.tags).toEqual(['ankara', 'new']);
      expect(r.body.variants.map((v: any) => v.sku).sort()).toEqual(['ANK004-BLAC-L', 'ANK004-BLAC-M', 'ANK004-BROW-L', 'ANK004-BROW-M']);
      expect(r.body.options).toEqual([{ name: 'Colour', values: ['Black', 'Brown'] }, { name: 'Size', values: ['M', 'L'] }]);
      expect(r.body.stock).toMatchObject({ available: 8, outOfStock: false });

      await create(a.h, { name: 'Dup', variants: [{ attributes: { Colour: 'Red' }, priceMinor: '1' }, { attributes: { colour: 'red' }, priceMinor: '1' }] }).expect(400);
      await create(a.h, { name: 'Mixed', variants: [{ attributes: { Colour: 'Red' }, priceMinor: '1' }, { attributes: { Size: 'L' }, priceMinor: '1' }] }).expect(400);
      await create(a.h, { name: 'Promo', variants: [{ attributes: {}, priceMinor: '100', promoPriceMinor: '200' }] }).expect(400);
      await create(a.h, { name: 'Float', variants: [{ attributes: {}, priceMinor: 25000.5 }] }).expect(400);
      await create(a.h, { name: 'Same code', productCode: 'ANK004', variants: simple() }).expect(409);
      await create(a.h, { name: 'Bad code', productCode: 'no spaces!', variants: simple() }).expect(400);
      await create(a.h, { name: 'Inactive only', status: 'ACTIVE', variants: [{ attributes: {}, priceMinor: '1', isActive: false }] }).expect(400);
    });

    it('updates keep the slug, deactivate removed variants, add new ones and protect SKUs', async () => {
      const a = await register();
      const p = (await create(a.h, { name: 'Oud Perfume', variants: [{ attributes: { Size: '50ml' }, priceMinor: '900000' }, { attributes: { Size: '100ml' }, priceMinor: '1200000', sku: 'OUD-100' }] }).expect(201)).body;
      const other = (await create(a.h, { name: 'Body Mist', variants: [{ attributes: {}, priceMinor: '300000', sku: 'MIST-1' }] }).expect(201)).body;
      const keep = p.variants.find((v: any) => v.attributes.Size === '100ml');
      const u = await http.patch(`/api/v1/products/${p.id}`).set(a.h).send({
        name: 'Royal Oud Perfume',
        variants: [{ id: keep.id, attributes: { Size: '100ml' }, priceMinor: '1300000', sku: 'OUD-100' }, { attributes: { Size: '200ml' }, priceMinor: '2000000', initialStock: 4 }],
      }).expect(200);
      expect(u.body).toMatchObject({ name: 'Royal Oud Perfume', slug: 'oud-perfume' });
      const active = u.body.variants.filter((v: any) => v.isActive);
      expect(active.map((v: any) => v.attributes.Size).sort()).toEqual(['100ml', '200ml']);
      expect(u.body.variants.find((v: any) => v.attributes.Size === '50ml').isActive).toBe(false);
      expect(active.find((v: any) => v.attributes.Size === '200ml').inventory.onHand).toBe(4);

      await http.patch(`/api/v1/products/${p.id}`).set(a.h).send({ variants: [{ id: keep.id, attributes: { Size: '100ml' }, priceMinor: '1', sku: 'MIST-1' }] }).expect(409);
      await http.patch(`/api/v1/products/${p.id}`).set(a.h).send({ variants: [{ id: other.variants[0].id, attributes: { Size: '1' }, priceMinor: '1' }] }).expect(400); // another product's variant
    });

    it('enforces tenant ownership of categories, products and variants', async () => {
      const a = await register();
      const b = await register();
      const bCat = (await http.post('/api/v1/categories').set(b.h).send({ name: 'Bags' }).expect(201)).body;
      await create(a.h, { name: 'Bag', categoryId: bCat.id, variants: simple() }).expect(404);
      const bProd = (await create(b.h, { name: 'Wig', variants: simple() }).expect(201)).body;
      await http.get(`/api/v1/products/${bProd.id}`).set(a.h).expect(404);
      await http.patch(`/api/v1/products/${bProd.id}`).set(a.h).send({ name: 'pwned' }).expect(404);
      await http.post('/api/v1/products/bulk').set(a.h).send({ productIds: [bProd.id], action: 'set_status', status: 'ARCHIVED' }).expect(404);
      await http.post(`/api/v1/inventory/variants/${bProd.variants[0].id}/adjust`).set(a.h).send({ mode: 'add', quantity: 5, reason: 'pwned' }).expect(404);
      await http.get(`/api/v1/products/${bProd.id}`).set({ ...a.h, 'X-Tenant-Id': b.tenantId }).expect(403);
      expect((await http.get('/api/v1/products').set(a.h).expect(200)).body.total).toBe(0);
    });

    it('categories: tree with cycle prevention; only empty categories can be deleted', async () => {
      const a = await register();
      const parent = (await http.post('/api/v1/categories').set(a.h).send({ name: 'Fashion' }).expect(201)).body;
      const child = (await http.post('/api/v1/categories').set(a.h).send({ name: 'Bags', parentId: parent.id }).expect(201)).body;
      await http.patch(`/api/v1/categories/${parent.id}`).set(a.h).send({ parentId: child.id }).expect(400);
      await http.patch(`/api/v1/categories/${child.id}`).set(a.h).send({ parentId: child.id }).expect(400);
      const p = (await create(a.h, { name: 'Tote', categoryId: child.id, variants: simple() }).expect(201)).body;
      await http.delete(`/api/v1/categories/${child.id}`).set(a.h).expect(409);
      await http.delete(`/api/v1/products/${p.id}`).set(a.h).expect(204);
      await http.delete(`/api/v1/categories/${child.id}`).set(a.h).expect(204);
      const list = (await http.get('/api/v1/categories').set(a.h).expect(200)).body;
      expect(list.map((c: any) => c.name)).toEqual(['Fashion']);
      const dupe = (await http.post('/api/v1/categories').set(a.h).send({ name: 'Fashion' }).expect(201)).body;
      expect(dupe.slug).toBe('fashion-2');
    });

    it('lists with search (name, code, SKU), stock filters and pagination', async () => {
      const a = await register();
      await create(a.h, { name: 'Leather Bag', productCode: 'BAG001', variants: simple('2500000', 20), status: 'ACTIVE' }).expect(201);
      await create(a.h, { name: 'Canvas Tote', variants: [{ attributes: {}, priceMinor: '800000', initialStock: 2, sku: 'TOTE-CNV' }], lowStockThreshold: 5, status: 'ACTIVE' }).expect(201);
      await create(a.h, { name: 'Silk Scarf', variants: simple('500000', 0) }).expect(201);
      const q = (s: string) => http.get(`/api/v1/products?${s}`).set(a.h).expect(200).then((r) => r.body);
      expect((await q('search=leather')).items.map((p: any) => p.productCode)).toEqual(['BAG001']);
      expect((await q('search=tote-cnv')).items).toHaveLength(1);
      expect((await q('stock=low')).items.map((p: any) => p.name)).toEqual(['Canvas Tote']);
      expect((await q('stock=out')).items.map((p: any) => p.name)).toEqual(['Silk Scarf']);
      expect((await q('status=DRAFT')).items.map((p: any) => p.name)).toEqual(['Silk Scarf']);
      const page = await q('pageSize=2&page=2&sort=name');
      expect(page).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(page.items.map((p: any) => p.name)).toEqual(['Silk Scarf']);
      expect((await q('sort=price_desc')).items[0]).toMatchObject({ name: 'Leather Bag', priceMin: '2500000' });
      await http.get('/api/v1/products?search=%25').set(a.h).expect(200); // wildcard is escaped
    });

    it('bulk updates status, tags and prices (integer kobo) and refuses unsellable activation', async () => {
      const a = await register();
      const p1 = (await create(a.h, { name: 'Cap', variants: [{ attributes: {}, priceMinor: '1000005', promoPriceMinor: '900000' }] }).expect(201)).body;
      const p2 = (await create(a.h, { name: 'Hat', variants: [{ attributes: {}, priceMinor: '200000', isActive: false }] }).expect(201)).body;
      await http.post('/api/v1/products/bulk').set(a.h).send({ productIds: [p1.id, p2.id], action: 'set_status', status: 'ACTIVE' }).expect(409);
      await http.post('/api/v1/products/bulk').set(a.h).send({ productIds: [p1.id, p2.id], action: 'add_tags', tags: ['Sale'] }).expect(200);
      await http.post('/api/v1/products/bulk').set(a.h).send({ productIds: [p1.id], action: 'adjust_price', percent: -10 }).expect(200);
      const after = (await http.get(`/api/v1/products/${p1.id}`).set(a.h).expect(200)).body;
      expect(after.tags).toEqual(['sale']);
      expect(after.variants[0]).toMatchObject({ priceMinor: '900005', promoPriceMinor: '810000' }); // 1,000,005 × 0.9 = 900,004.5 → round half up
      await http.post('/api/v1/products/bulk').set(a.h).send({ productIds: [p1.id], action: 'adjust_price', percent: 1000 }).expect(400);
    });

    it('soft-deleted products disappear but their code stays reserved', async () => {
      const a = await register();
      const p = (await create(a.h, { name: 'Wig', productCode: 'WIG005', variants: simple() }).expect(201)).body;
      await http.delete(`/api/v1/products/${p.id}`).set(a.h).expect(204);
      await http.get(`/api/v1/products/${p.id}`).set(a.h).expect(404);
      expect((await http.get('/api/v1/products').set(a.h).expect(200)).body.total).toBe(0);
      await create(a.h, { name: 'Wig again', productCode: 'WIG005', variants: simple() }).expect(409);
    });

    it('enforces the plan product limit, and roles', async () => {
      const a = await register();
      const tiny = await prisma.subscriptionPlan.create({
        data: { code: `TINY_${uniq().toUpperCase().replace(/[^A-Z0-9]/g, '')}`.slice(0, 30), name: 'Tiny', monthlyPriceMinor: 100n, annualPriceMinor: null, limits: { products: 1, ordersPerMonth: null, staff: 1, paymentGateways: 1 }, features: {}, isPublic: false },
      });
      await prisma.subscription.updateMany({ where: { tenantId: a.tenantId }, data: { planId: tiny.id } });
      await create(a.h, { name: 'One', variants: simple() }).expect(201);
      const r = await create(a.h, { name: 'Two', variants: simple() }).expect(403);
      expect(r.body.code).toBe('PLAN_LIMIT_REACHED');
      const csv = 'name,price\nNew A,100\nNew B,200\n';
      expect((await http.post('/api/v1/products/import').set(a.h).send({ csv }).expect(403)).body.code).toBe('PLAN_LIMIT_REACHED');

      const b = await register();
      const assistant = await member(b.tenantId, 'SALES_ASSISTANT');
      await http.get('/api/v1/products').set(assistant).expect(200);
      await create(assistant, { name: 'Nope', variants: simple() }).expect(403);
      const p = (await create(b.h, { name: 'Shoe', variants: simple() }).expect(201)).body;
      await http.post(`/api/v1/inventory/variants/${p.variants[0].id}/adjust`).set(assistant).send({ mode: 'add', quantity: 1, reason: 'test' }).expect(403);
      await http.get('/api/v1/inventory/low-stock').set(assistant).expect(200);
    });

    it('product media: images and video upload to S3, are tenant-bound and single use, and removed files are deleted', async () => {
      const a = await register();
      const b = await register();
      const img = await upload(a.h, '/api/v1/products/media/upload-url', PNG, 'image/png');
      const vid = await upload(a.h, '/api/v1/products/media/upload-url', MP4, 'video/mp4');
      await create(b.h, { name: 'Stolen', variants: simple(), media: [{ key: img, type: 'image' }] }).expect(400);
      const p = (await create(a.h, { name: 'Media Bag', variants: simple(), media: [{ key: img, type: 'image', alt: 'Front' }, { key: vid, type: 'video' }] }).expect(201)).body;
      expect(p.media.map((m: any) => [m.type, m.alt ?? null])).toEqual([['image', 'Front'], ['video', null]]);
      const imgUrl = p.media[0].url;
      expect((await fetch(imgUrl)).status).toBe(200);
      await create(a.h, { name: 'Reuse', variants: simple(), media: [{ key: img, type: 'image' }] }).expect(400); // already consumed
      expect((await http.get('/api/v1/products').set(a.h).expect(200)).body.items[0].thumbnailUrl).toBeTruthy();

      await http.patch(`/api/v1/products/${p.id}`).set(a.h).send({ media: [{ key: vid, type: 'video' }] }).expect(200);
      expect((await fetch(imgUrl)).status).toBe(404); // removed image deleted from storage
      const fake = await upload(a.h, '/api/v1/products/media/upload-url', Buffer.from('<html>'.padEnd(64)), 'image/png');
      await http.patch(`/api/v1/products/${p.id}`).set(a.h).send({ media: [{ key: fake, type: 'image' }] }).expect(400);
      await http.post('/api/v1/products/media/upload-url').set(a.h).send({ contentType: 'image/svg+xml', contentLength: 10 }).expect(400);
    });
  });

  // ───────────────────────── Inventory ─────────────────────────
  describe('inventory', () => {
    it('§26 #6: adjusts stock with an auditable movement history and never below reserved units', async () => {
      const a = await register();
      const p = (await create(a.h, { name: 'Cap', variants: simple('100000', 10), lowStockThreshold: 3 }).expect(201)).body;
      const vid = p.variants[0].id;
      const adj = (body: object) => http.post(`/api/v1/inventory/variants/${vid}/adjust`).set(a.h).send(body);
      expect((await adj({ mode: 'add', quantity: 5, reason: 'Supplier delivery' }).expect(201)).body).toEqual({ onHand: 15, reserved: 0, available: 15 });
      expect((await adj({ mode: 'remove', quantity: 2, reason: 'Damaged' }).expect(201)).body.onHand).toBe(13);
      expect((await adj({ mode: 'set', quantity: 9, reason: 'Stock count' }).expect(201)).body.onHand).toBe(9);
      await adj({ mode: 'remove', quantity: 10, reason: 'Too many' }).expect(409);

      await prisma.tenantTransaction(a.tenantId, (tx) => inventory.reserve(tx, a.tenantId, [{ variantId: vid, quantity: 7 }], null, null));
      const below = await adj({ mode: 'set', quantity: 6, reason: 'Count' }).expect(409);
      expect(below.body.code).toBe('BELOW_RESERVED');
      const moves = (await http.get(`/api/v1/inventory/movements?variantId=${vid}`).set(a.h).expect(200)).body;
      expect(moves.map((m: any) => [m.type, m.quantity, m.onHandAfter, m.reservedAfter])).toEqual([
        ['RESERVATION', 7, 9, 7], ['ADJUSTMENT', -4, 9, 0], ['ADJUSTMENT', -2, 13, 0], ['RESTOCK', 5, 15, 0], ['RESTOCK', 10, 10, 0],
      ]);
      const low = (await http.get('/api/v1/inventory/low-stock').set(a.h).expect(200)).body;
      expect(low).toEqual([expect.objectContaining({ variantId: vid, onHand: 9, reserved: 7, available: 2, threshold: 3 })]);
      const audit = await prisma.auditLog.count({ where: { tenantId: a.tenantId, action: 'inventory.adjusted' } });
      expect(audit).toBe(3);
      await expect(prisma.inventoryMovement.updateMany({ where: { tenantId: a.tenantId }, data: { quantity: 1 } })).rejects.toThrow(/append-only/);
    });

    it('§26 #7: two customers try to buy the last item at the same time — exactly one gets it', async () => {
      const a = await register();
      const p = (await create(a.h, { name: 'Last Bag', variants: simple('2500000', 1) }).expect(201)).body;
      const vid = p.variants[0].id;
      const attempt = () => prisma.tenantTransaction(a.tenantId, (tx) => inventory.reserve(tx, a.tenantId, [{ variantId: vid, quantity: 1 }], randomUUID(), null))
        .then(() => 'ok' as const, (e) => (e instanceof InsufficientStockError ? ('sold_out' as const) : Promise.reject(e)));
      const results = await Promise.all([attempt(), attempt()]);
      expect(results.sort()).toEqual(['ok', 'sold_out']);
      const inv = await prisma.inventory.findUniqueOrThrow({ where: { variantId: vid } });
      expect(inv).toMatchObject({ onHand: 1, reserved: 1 });

      const q = (await create(a.h, { name: 'Popular Cap', variants: simple('100000', 3) }).expect(201)).body;
      const qid = q.variants[0].id;
      const many = await Promise.all(Array.from({ length: 10 }, () =>
        prisma.tenantTransaction(a.tenantId, (tx) => inventory.reserve(tx, a.tenantId, [{ variantId: qid, quantity: 1 }], null, null)).then(() => 1, () => 0)));
      expect(many.reduce((s: number, x) => s + x, 0)).toBe(3);
      expect((await prisma.inventory.findUniqueOrThrow({ where: { variantId: qid } })).reserved).toBe(3);
    });

    it('reservations are all-or-nothing; release and sale keep balances consistent', async () => {
      const a = await register();
      const p = (await create(a.h, { name: 'Set', variants: [{ attributes: { Size: 'S' }, priceMinor: '1', initialStock: 5 }, { attributes: { Size: 'M' }, priceMinor: '1', initialStock: 1 }] }).expect(201)).body;
      const [s, m] = [p.variants.find((v: any) => v.attributes.Size === 'S').id, p.variants.find((v: any) => v.attributes.Size === 'M').id];
      const tx = <T>(fn: (t: any) => Promise<T>) => prisma.tenantTransaction(a.tenantId, fn);
      const err = await tx((t) => inventory.reserve(t, a.tenantId, [{ variantId: s, quantity: 2 }, { variantId: m, quantity: 2 }], null, null)).catch((e) => e);
      expect(err).toBeInstanceOf(InsufficientStockError);
      expect(err.shortages).toEqual([{ variantId: m, requested: 2, available: 1 }]);
      expect((await prisma.inventory.findUniqueOrThrow({ where: { variantId: s } })).reserved).toBe(0); // nothing partially reserved

      const order = randomUUID();
      await tx((t) => inventory.reserve(t, a.tenantId, [{ variantId: s, quantity: 3 }], order, null));
      await tx((t) => inventory.release(t, a.tenantId, [{ variantId: s, quantity: 10 }], order, null)); // never below 0
      expect(await prisma.inventory.findUniqueOrThrow({ where: { variantId: s } })).toMatchObject({ onHand: 5, reserved: 0 });
      await tx((t) => inventory.reserve(t, a.tenantId, [{ variantId: s, quantity: 2 }], order, null));
      await tx((t) => inventory.commitSale(t, a.tenantId, [{ variantId: s, quantity: 2 }], order, null));
      expect(await prisma.inventory.findUniqueOrThrow({ where: { variantId: s } })).toMatchObject({ onHand: 3, reserved: 0 });
      await expect(tx((t) => inventory.commitSale(t, a.tenantId, [{ variantId: s, quantity: 1 }], order, null))).rejects.toThrow();
      // Another tenant's scope cannot touch this stock.
      const b = await register();
      await expect(prisma.tenantTransaction(b.tenantId, (t) => inventory.reserve(t, b.tenantId, [{ variantId: s, quantity: 1 }], null, null))).rejects.toBeInstanceOf(InsufficientStockError);
    });
  });

  // ───────────────────────── Import / export ─────────────────────────
  describe('CSV import and export', () => {
    const CSV = [
      'product_code,name,description,category,status,tags,attributes,sku,price,promo_price,cost_price,stock,weight_grams',
      'BAG001,Premium Leather Bag,"Hand-stitched, Lagos made",Bags,ACTIVE,leather;new,Colour=Black,BAG001-BLK,"25,000",,15000,4,900',
      'BAG001,,,,,,Colour=Brown,BAG001-BRN,25000,22000.50,15000,2,',
      ',Silk Scarf,,Accessories,DRAFT,,,,5000,,,10,',
    ].join('\n');

    it('dry run reports, real run imports all-or-nothing, re-import updates instead of duplicating', async () => {
      const a = await register();
      const dry = (await http.post('/api/v1/products/import').set(a.h).send({ csv: CSV, dryRun: true }).expect(200)).body;
      expect(dry).toMatchObject({ dryRun: true, rows: 3, productsCreated: 2, productsUpdated: 0, variantsCreated: 3 });
      expect((await http.get('/api/v1/products').set(a.h)).body.total).toBe(0);

      const res = (await http.post('/api/v1/products/import').set(a.h).send({ csv: CSV }).expect(200)).body;
      expect(res).toMatchObject({ dryRun: false, productsCreated: 2, variantsCreated: 3 });
      const bag = (await http.get('/api/v1/products/by-code/BAG001').set(a.h).expect(200)).body;
      expect(bag).toMatchObject({ name: 'Premium Leather Bag', status: 'ACTIVE', category: { name: 'Bags' }, tags: ['leather', 'new'], weightGrams: 900 });
      const brn = bag.variants.find((v: any) => v.sku === 'BAG001-BRN');
      expect(brn).toMatchObject({ priceMinor: '2500000', promoPriceMinor: '2200050', costPriceMinor: '1500000', inventory: { onHand: 2 } });
      const scarf = (await http.get('/api/v1/products?search=scarf').set(a.h)).body.items[0];
      expect(scarf.productCode).toMatch(/^[A-Z]+\d{3}$/);
      expect((await http.get('/api/v1/categories').set(a.h)).body.map((c: any) => c.name).sort()).toEqual(['Accessories', 'Bags']);

      // Round trip: export → import changes nothing structurally; edited stock is applied as a count.
      const exported = (await http.get('/api/v1/products/export').set(a.h).expect(200)).text;
      expect(exported.split('\r\n')[0]).toBe('﻿product_code,name,description,category,status,tags,attributes,sku,price,promo_price,cost_price,stock,active,weight_grams,low_stock_threshold');
      const edited = exported.replace('BAG001-BLK,25000.00,,15000.00,4,', 'BAG001-BLK,26000.00,,15000.00,9,');
      const again = (await http.post('/api/v1/products/import').set(a.h).send({ csv: edited }).expect(200)).body;
      expect(again).toMatchObject({ productsCreated: 0, productsUpdated: 2, variantsCreated: 0, variantsUpdated: 3 });
      const blk = (await http.get('/api/v1/products/by-code/BAG001').set(a.h)).body.variants.find((v: any) => v.sku === 'BAG001-BLK');
      expect(blk).toMatchObject({ priceMinor: '2600000', inventory: { onHand: 9 } });
      expect((await http.get('/api/v1/products').set(a.h)).body.total).toBe(2);
    });

    it('reports every invalid row with its spreadsheet row number and imports nothing', async () => {
      const a = await register();
      const bad = [
        'name,price,promo_price,attributes,sku,status,stock',
        'Good one,100,,,,,1',
        'Cheap,abc,,,,,',
        'Promo,100,200,,,,',
        'Attr,100,,Colour,,,',
        'Sku,100,,,bad sku!,,',
        'Status,100,,,,LIVE,',
        'Stock,100,,,,,-3',
      ].join('\n');
      const r = await http.post('/api/v1/products/import').set(a.h).send({ csv: bad }).expect(400);
      expect(r.body.code).toBe('IMPORT_INVALID');
      expect(r.body.errors.map((e: any) => e.row)).toEqual([3, 4, 5, 6, 7, 8]);
      expect((await http.get('/api/v1/products').set(a.h)).body.total).toBe(0);
      await http.post('/api/v1/products/import').set(a.h).send({ csv: 'title,cost\nX,1' }).expect(400);
      await http.post('/api/v1/products/import').set(a.h).send({ csv: 'name,price\n"unterminated,1' }).expect(400);

      const b = await register();
      await create(b.h, { name: 'Theirs', variants: [{ attributes: {}, priceMinor: '1', sku: 'SHARED-1' }] }).expect(201);
      await create(a.h, { name: 'Mine', productCode: 'MINE01', variants: [{ attributes: {}, priceMinor: '1', sku: 'MINE-1' }] }).expect(201);
      // Same SKU in another store is fine; a SKU owned by a different product in this store is not.
      await http.post('/api/v1/products/import').set(a.h).send({ csv: 'name,price,sku\nNew,1,SHARED-1' }).expect(200);
      const clash = await http.post('/api/v1/products/import').set(a.h).send({ csv: 'product_code,name,price,sku\nOTHER1,Other,1,MINE-1' }).expect(400);
      expect(clash.body.errors[0].message).toMatch(/already belongs to product MINE01/);
    });

    it('exports neutralise spreadsheet formulas', async () => {
      const a = await register();
      await create(a.h, { name: '=HYPERLINK("http://evil.example")', variants: simple() }).expect(201);
      const csv = (await http.get('/api/v1/products/export').set(a.h).expect(200)).text;
      expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
      expect(csv).not.toMatch(/,=HYPERLINK/);
    });
  });

  // ───────────────────────── Storefront ─────────────────────────
  describe('storefront', () => {
    async function readyStore() {
      const a = await register();
      await http.patch('/api/v1/store/profile').set(a.h).send({ description: 'Lagos fashion, live every Friday.', whatsappNumber: '+2348031234567' }).expect(200);
      const cat = (await http.post('/api/v1/categories').set(a.h).send({ name: 'Bags' }).expect(201)).body;
      const bag = (await create(a.h, {
        name: 'Premium Leather Bag', productCode: 'BAG001', categoryId: cat.id, status: 'ACTIVE', lowStockThreshold: 3, tags: ['leather'],
        variants: [
          { attributes: { Colour: 'Black' }, priceMinor: '2500000', promoPriceMinor: '2200000', costPriceMinor: '1200000', initialStock: 2 },
          { attributes: { Colour: 'Brown' }, priceMinor: '2500000', costPriceMinor: '1200000', initialStock: 10 },
          { attributes: { Colour: 'Wine' }, priceMinor: '2500000', initialStock: 0, isActive: false },
        ],
      }).expect(201)).body;
      await create(a.h, { name: 'Secret Draft', status: 'DRAFT', variants: simple() }).expect(201);
      const sold = (await create(a.h, { name: 'Sold Out Shoe', status: 'ACTIVE', variants: simple('1000000', 0) }).expect(201)).body;
      return { ...a, bag, sold, cat };
    }

    it('publishing needs a description, a contact number and an active product', async () => {
      const a = await register();
      const r = await http.post('/api/v1/storefront/publish').set(a.h).expect(409);
      expect(r.body.code).toBe('STOREFRONT_NOT_READY');
      // Registration already sets the contact phone, so only the description and a product are missing.
      expect(r.body.missing.map((m: any) => m.key)).toEqual(['description', 'product']);
      await http.get(`/api/v1/store/${a.slug}`).expect(404);
      const s = await readyStore();
      const ok = (await http.post('/api/v1/storefront/publish').set(s.h).expect(200)).body;
      expect(ok.isPublished).toBe(true);
      expect(ok.publicUrl).toMatch(new RegExp(`/store/${s.slug}$`));
      expect(ok.readiness.every((x: any) => x.done)).toBe(true);
      const assistant = await member(s.tenantId, 'SALES_ASSISTANT');
      await http.post('/api/v1/storefront/unpublish').set(assistant).expect(403);
    });

    it('the public storefront shows only sellable data — never cost prices, drafts, inactive variants or exact stock', async () => {
      const s = await readyStore();
      await http.patch('/api/v1/storefront').set(s.h).send({ orderInstructions: 'Send the code (e.g. BAG001) to our WhatsApp.', accentColor: '#1d4ed8' }).expect(200);
      await http.patch('/api/v1/storefront').set(s.h).send({ accentColor: 'red' }).expect(400);
      await http.post('/api/v1/storefront/publish').set(s.h).expect(200);

      const store = (await http.get(`/api/v1/store/${s.slug}`).expect(200)).body;
      expect(store).toMatchObject({ businessName: s.body.businessName, whatsappNumber: '+2348031234567', accentColor: '#1d4ed8', orderInstructions: expect.stringContaining('BAG001'), categories: [{ name: 'Bags', slug: 'bags' }] });
      const list = (await http.get(`/api/v1/store/${s.slug}/products`).expect(200)).body;
      expect(list.items.map((p: any) => p.name).sort()).toEqual(['Premium Leather Bag', 'Sold Out Shoe']);
      const bag = list.items.find((p: any) => p.productCode === 'BAG001');
      expect(bag).toMatchObject({ priceMinor: '2200000', compareAtMinor: '2500000', availability: 'in_stock', category: 'Bags' });
      expect(list.items.find((p: any) => p.name === 'Sold Out Shoe').availability).toBe('out_of_stock');

      const detail = (await http.get(`/api/v1/store/${s.slug}/products/premium-leather-bag`).expect(200)).body;
      expect(detail.variants.map((v: any) => v.attributes.Colour)).toEqual(['Black', 'Brown']); // Wine is inactive
      expect(detail.variants[0]).toMatchObject({ availability: 'low_stock', onlyLeft: 2, priceMinor: '2200000', compareAtMinor: '2500000' });
      expect(detail.variants[1]).toEqual(expect.not.objectContaining({ onlyLeft: expect.anything() }));
      const raw = JSON.stringify([store, list, detail]);
      for (const secret of ['costPrice', 'onHand', 'reserved', 'tenantId', '1200000']) expect(raw).not.toContain(secret);

      expect((await http.get(`/api/v1/store/${s.slug}/code/bag001`).expect(200)).body.name).toBe('Premium Leather Bag');
      await http.get(`/api/v1/store/${s.slug}/code/NOPE99`).expect(404);
      await http.get(`/api/v1/store/${s.slug}/products/secret-draft`).expect(404);
      expect((await http.get(`/api/v1/store/${s.slug}/products?search=bag001`).expect(200)).body.total).toBe(1);
      expect((await http.get(`/api/v1/store/${s.slug}/products?search=leather`).expect(200)).body.total).toBe(1); // tag
      expect((await http.get(`/api/v1/store/${s.slug}/products?category=bags`).expect(200)).body.total).toBe(1);
      expect((await http.get(`/api/v1/store/${s.slug}/products?sort=price_asc`).expect(200)).body.items[0].name).toBe('Sold Out Shoe');
      await http.get(`/api/v1/store/${s.slug}/products?pageSize=500`).expect(400);
    });

    it('the storefront disappears when unpublished, suspended or the subscription lapses; archived products vanish', async () => {
      const s = await readyStore();
      await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
      await http.get(`/api/v1/store/${s.slug}`).expect(200);
      await http.patch(`/api/v1/products/${s.bag.id}`).set(s.h).send({ status: 'ARCHIVED' }).expect(200);
      await http.get(`/api/v1/store/${s.slug}/products/premium-leather-bag`).expect(404);

      await prisma.subscription.updateMany({ where: { tenantId: s.tenantId }, data: { status: 'EXPIRED' } });
      const lapsed = await http.get(`/api/v1/store/${s.slug}`).expect(404);
      await prisma.subscription.updateMany({ where: { tenantId: s.tenantId }, data: { status: 'TRIALING' } });
      await prisma.tenant.update({ where: { id: s.tenantId }, data: { status: 'SUSPENDED' } });
      const suspended = await http.get(`/api/v1/store/${s.slug}`).expect(404);
      const unknown = await http.get('/api/v1/store/no-such-store-here').expect(404);
      expect(lapsed.body.message).toBe(unknown.body.message);
      expect(suspended.body.message).toBe(unknown.body.message);
    });

    it('cover image upload; reserved slugs keep seller routes unambiguous', async () => {
      const s = await readyStore();
      const key = await upload(s.h, '/api/v1/storefront/cover/upload-url', PNG, 'image/png');
      const r = (await http.put('/api/v1/storefront/cover').set(s.h).send({ key }).expect(200)).body;
      expect(r.coverUrl).toContain(key);
      await http.post('/api/v1/storefront/publish').set(s.h).expect(200);
      expect((await http.get(`/api/v1/store/${s.slug}`).expect(200)).body.coverUrl).toContain(key);
      expect((await http.delete('/api/v1/storefront/cover').set(s.h).expect(200)).body.coverUrl).toBeNull();

      await http.get('/api/v1/store/profile').expect(401); // seller route, not a store called "profile"
      const u = uniq();
      await http.post('/api/v1/auth/register').send({
        businessName: 'Profile', ownerFullName: 'X Y', email: `r-${u}@example.com`, phone: phone(), country: 'NG', state: 'Lagos', city: 'Ikeja',
        businessAddress: '1 Road', businessCategory: 'Other', storeUsername: 'profile', businessType: 'INDIVIDUAL', password: PASSWORD, acceptTerms: true, acceptPrivacy: true,
      }).expect(409);
    });
  });

  // ───────────────────────── Customers ─────────────────────────
  describe('customers (CRM)', () => {
    async function order(tenantId: string, customerId: string, o: { status: string; paymentStatus: string; total: bigint; daysAgo?: number; currency?: string }) {
      return prisma.forTenant(tenantId).order.create({
        data: {
          reference: `LS-${uniq()}`, customerId, status: o.status, paymentStatus: o.paymentStatus, subtotalMinor: o.total, totalMinor: o.total,
          currency: o.currency ?? 'NGN', createdAt: new Date(Date.now() - (o.daysAgo ?? 0) * DAY), shippingAddress: { line1: '1 Secret Close', city: 'Lekki' },
        } as any,
      });
    }

    it('creates customers with an address, rejects duplicates and contact-less records, records opt-in time', async () => {
      const a = await register();
      const ph = phone();
      const c = (await http.post('/api/v1/customers').set(a.h).send({ fullName: 'Chiamaka Eze', phone: ph, tags: ['VIP', 'lagos'], address: { line1: '5 Admiralty Way', city: 'Lekki', state: 'Lagos', landmark: 'Near Mega Plaza' } }).expect(201)).body;
      expect(c).toMatchObject({ fullName: 'Chiamaka Eze', phone: ph, tags: ['vip', 'lagos'], whatsappOptIn: false, optInAt: null });
      expect(c.addresses).toEqual([expect.objectContaining({ line1: '5 Admiralty Way', isDefault: true, country: 'NG' })]);
      expect(c.stats).toMatchObject({ orderCount: 0, totalSpentMinor: '0', repeat: false });
      const dup = await http.post('/api/v1/customers').set(a.h).send({ fullName: 'Someone', phone: ph }).expect(409);
      expect(dup.body).toMatchObject({ code: 'DUPLICATE_PHONE', customerId: c.id });
      await http.post('/api/v1/customers').set(a.h).send({ fullName: 'Nobody' }).expect(400);
      await http.post('/api/v1/customers').set(a.h).send({ fullName: 'Bad', phone: '0803' }).expect(400);
      const u = (await http.patch(`/api/v1/customers/${c.id}`).set(a.h).send({ whatsappOptIn: true }).expect(200)).body;
      expect(u.whatsappOptIn).toBe(true);
      expect(u.optInAt).not.toBeNull();
      await http.patch(`/api/v1/customers/${c.id}`).set(a.h).send({ phone: null }).expect(400); // would leave no contact
      const b = await register();
      await http.post('/api/v1/customers').set(b.h).send({ fullName: 'Same phone, other store', phone: ph }).expect(201);
      await http.get(`/api/v1/customers/${c.id}`).set(b.h).expect(404);
      await http.patch(`/api/v1/customers/${c.id}`).set(b.h).send({ fullName: 'Hijacked Name' }).expect(404);
    });

    it('stats and segments come from real orders: repeat, vip, inactive, outstanding, opted in; sorted by spend', async () => {
      const a = await register();
      const mk = async (fullName: string, extra: object = {}) => (await http.post('/api/v1/customers').set(a.h).send({ fullName, phone: phone(), ...extra }).expect(201)).body.id as string;
      const big = await mk('Big Spender', { whatsappOptIn: true });
      const repeatC = await mk('Repeat Buyer');
      const lapsed = await mk('Lapsed Buyer');
      const waiting = await mk('Waiting Payment');
      const others = await Promise.all(Array.from({ length: 8 }, (_, i) => mk(`Small ${i}`)));
      await order(a.tenantId, big, { status: 'DELIVERED', paymentStatus: 'PAID', total: 50_000_000n });
      await order(a.tenantId, repeatC, { status: 'DELIVERED', paymentStatus: 'PAID', total: 1_000_000n });
      await order(a.tenantId, repeatC, { status: 'PAID', paymentStatus: 'PAID', total: 1_500_000n });
      await order(a.tenantId, lapsed, { status: 'DELIVERED', paymentStatus: 'PAID', total: 2_000_000n, daysAgo: 120 });
      await order(a.tenantId, waiting, { status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', total: 800_000n });
      await order(a.tenantId, waiting, { status: 'DRAFT', paymentStatus: 'UNPAID', total: 9_000_000n });
      for (const id of others) await order(a.tenantId, id, { status: 'DELIVERED', paymentStatus: 'PAID', total: 100_000n });
      await order(a.tenantId, others[0], { status: 'DELIVERED', paymentStatus: 'PAID', total: 7_700n, currency: 'USD' }); // other currency not summed

      const seg = async (s: string) => (await http.get(`/api/v1/customers?segment=${s}`).set(a.h).expect(200)).body.items.map((c: any) => c.fullName).sort();
      expect(await seg('repeat')).toEqual(['Repeat Buyer', 'Small 0']);
      // 11 buyers with NGN spend; PERCENT_RANK ≤ 0.1 → ranks 1–2 (Waiting has no paid spend; the USD order isn't summed).
      expect(await seg('vip')).toEqual(['Big Spender', 'Repeat Buyer']);
      expect(await seg('inactive')).toEqual(['Lapsed Buyer']);
      expect(await seg('outstanding')).toEqual(['Repeat Buyer', 'Waiting Payment']);
      expect(await seg('opted_in')).toEqual(['Big Spender']);
      expect((await seg('new')).length).toBe(12);
      const bySpend = (await http.get('/api/v1/customers?sort=spend&pageSize=3').set(a.h).expect(200)).body;
      expect(bySpend.items.map((c: any) => [c.fullName, c.totalSpentMinor])).toEqual([['Big Spender', '50000000'], ['Repeat Buyer', '2500000'], ['Lapsed Buyer', '2000000']]);
      expect(bySpend.total).toBe(12);
      const detail = (await http.get(`/api/v1/customers/${waiting}`).set(a.h).expect(200)).body;
      expect(detail.stats).toMatchObject({ orderCount: 1, paidCount: 0, outstanding: 1, totalSpentMinor: '0' });
      expect(detail.orders).toHaveLength(1); // drafts excluded
      expect((await http.get('/api/v1/customers?search=repeat').set(a.h)).body.items).toHaveLength(1);
      expect((await http.get('/api/v1/customers?segment=everyone').set(a.h)).status).toBe(400);
    });

    it('export needs customers:export, is audited, excludes erased customers and neutralises formulas', async () => {
      const a = await register();
      await http.post('/api/v1/customers').set(a.h).send({ fullName: '=cmd|calc', email: 'x@example.com' }).expect(201);
      const gone = (await http.post('/api/v1/customers').set(a.h).send({ fullName: 'Gone Person', email: 'gone@example.com' }).expect(201)).body;
      await http.post(`/api/v1/customers/${gone.id}/anonymise`).set(a.h).expect(200);
      const manager = await member(a.tenantId, 'STORE_MANAGER');
      await http.get('/api/v1/customers').set(manager).expect(200);
      await http.get('/api/v1/customers/export').set(manager).expect(403);
      const csv = (await http.get('/api/v1/customers/export').set(a.h).expect(200)).text;
      expect(csv).toContain(`'=cmd|calc`);
      expect(csv).not.toContain('gone@example.com');
      expect(csv).not.toContain('Erased customer');
      const log = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: a.tenantId, action: 'customers.exported' } });
      expect(log.metadata).toMatchObject({ count: 1 });
    });

    it('erasure removes personal data incl. order address snapshots, refuses while orders are open; delete only without orders', async () => {
      const a = await register();
      const c = (await http.post('/api/v1/customers').set(a.h).send({ fullName: 'Ngozi Okafor', phone: phone(), notes: 'Prefers evening delivery', address: { line1: '9 Bourdillon', city: 'Ikoyi', state: 'Lagos' } }).expect(201)).body;
      const open = await order(a.tenantId, c.id, { status: 'PROCESSING', paymentStatus: 'PAID', total: 100n });
      await http.delete(`/api/v1/customers/${c.id}`).set(a.h).expect(409);
      expect((await http.post(`/api/v1/customers/${c.id}/anonymise`).set(a.h).expect(409)).body.code).toBe('OPEN_ORDERS');
      await prisma.forTenant(a.tenantId).order.update({ where: { id: open.id }, data: { status: 'DELIVERED' } });
      const erased = (await http.post(`/api/v1/customers/${c.id}/anonymise`).set(a.h).expect(200)).body;
      expect(erased).toMatchObject({ fullName: 'Erased customer', phone: null, email: null, notes: null, tags: [], addresses: [] });
      expect(erased.anonymizedAt).not.toBeNull();
      const o = await prisma.order.findUniqueOrThrow({ where: { id: open.id } });
      expect(o.shippingAddress).toBeNull();
      expect(o.totalMinor).toBe(100n); // accounting kept
      await http.patch(`/api/v1/customers/${c.id}`).set(a.h).send({ fullName: 'Back' }).expect(409);
      const plain = (await http.post('/api/v1/customers').set(a.h).send({ fullName: 'Never Ordered', email: 'n@example.com' }).expect(201)).body;
      await http.delete(`/api/v1/customers/${plain.id}`).set(a.h).expect(204);
      await http.get(`/api/v1/customers/${plain.id}`).set(a.h).expect(404);
      expect(await prisma.auditLog.count({ where: { tenantId: a.tenantId, action: { in: ['customer.anonymised', 'customer.deleted'] } } })).toBe(2);
    });

    it('addresses: one default at a time, scoped to the customer and tenant; tags listing', async () => {
      const a = await register();
      const c = (await http.post('/api/v1/customers').set(a.h).send({ fullName: 'Tunde Bakare', phone: phone(), tags: ['wholesale'] }).expect(201)).body;
      const first = (await http.post(`/api/v1/customers/${c.id}/addresses`).set(a.h).send({ line1: '1 First St', city: 'Yaba', state: 'Lagos' }).expect(201)).body;
      expect(first.isDefault).toBe(true);
      const second = (await http.post(`/api/v1/customers/${c.id}/addresses`).set(a.h).send({ line1: '2 Second St', city: 'Abuja', state: 'FCT', isDefault: true }).expect(201)).body;
      const detail = (await http.get(`/api/v1/customers/${c.id}`).set(a.h)).body;
      expect(detail.addresses.map((x: any) => [x.line1, x.isDefault])).toEqual([['2 Second St', true], ['1 First St', false]]);
      const other = (await http.post('/api/v1/customers').set(a.h).send({ fullName: 'Other', phone: phone() }).expect(201)).body;
      await http.patch(`/api/v1/customers/${other.id}/addresses/${second.id}`).set(a.h).send({ line1: '1 Hijack Road', city: 'Ikeja', state: 'Lagos' }).expect(404);
      await http.delete(`/api/v1/customers/${other.id}/addresses/${first.id}`).set(a.h).expect(404);
      await http.delete(`/api/v1/customers/${c.id}/addresses/${first.id}`).set(a.h).expect(204);
      const b = await register();
      await http.post(`/api/v1/customers/${c.id}/addresses`).set(b.h).send({ line1: '1 Other Rd', city: 'Ikeja', state: 'Lagos' }).expect(404);
      expect((await http.get('/api/v1/customers/tags').set(a.h).expect(200)).body).toEqual([{ tag: 'wholesale', count: 1 }]);
    });
  });
});
