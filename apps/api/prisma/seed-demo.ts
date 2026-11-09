/* eslint-disable no-console */
/**
 * DEVELOPMENT ONLY demo data: one seller ("Ada's Fashion House") with products, customers, orders and verified
 * payments over the last ~14 months, so the dashboard can be reviewed with realistic figures.
 * Refuses to run when NODE_ENV is production or staging. Safe to re-run: an existing demo store is left untouched.
 *
 *   npm run seed:demo        → sign in as demo@livesell.local / DemoSeller2026
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../src/generated/prisma/client';
import { SYSTEM_ROLES } from '../src/rbac/permissions';

if (['production', 'staging'].includes(process.env.NODE_ENV ?? '')) {
  console.error('seed-demo is for development only.');
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const EMAIL = 'demo@livesell.local';
const PASSWORD = 'DemoSeller2026';
const SLUG = 'ada-fashion-demo';
const DAY = 86_400_000;

// Deterministic pseudo-random so the demo looks the same each time.
let s = 42;
const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];

const PRODUCTS = [
  ['BAG001', 'Premium Leather Bag', 2_500_000n], ['SHOE002', "Men's Sneakers", 1_850_000n], ['DRESS003', "Women's Evening Dress", 3_200_000n],
  ['ANK004', 'Ankara Two-Piece', 1_500_000n], ['WIG005', 'Bone Straight Wig 22"', 9_500_000n], ['PERF006', 'Oud Perfume 100ml', 1_200_000n],
] as const;
const NAMES = ['Chiamaka Eze', 'Tunde Bakare', 'Aisha Bello', 'Ngozi Okafor', 'Emeka Nwosu', 'Funke Adeyemi', 'Ibrahim Musa', 'Blessing Udo', 'Kelechi Obi', 'Zainab Yusuf', 'Segun Ajayi', 'Amaka Nnaji'];

async function main() {
  // Audit rows are append-only (tenants are never hard-deleted), so an existing demo store is left as is.
  if (await prisma.tenant.findUnique({ where: { slug: SLUG } })) {
    console.log(`Demo seller already exists: ${EMAIL} / ${PASSWORD}. Recreate the dev database to reset it.`);
    return;
  }
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    create: { email: EMAIL, phone: '+2348000000001', fullName: 'Ada Okafor', passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() },
    update: { passwordHash, status: 'ACTIVE' },
  });
  const now = new Date();
  const tenant = await prisma.tenant.create({
    data: {
      slug: SLUG, businessName: "Ada's Fashion House", businessCategory: 'Fashion & Apparel', email: EMAIL, phone: '+2348000000001',
      state: 'Lagos', city: 'Lekki', address: '14 Admiralty Way, Lekki Phase 1', status: 'TRIAL', termsAcceptedAt: now, privacyAcceptedAt: now,
    },
  });
  const perms = await prisma.permission.findMany();
  const permId = new Map(perms.map((p) => [p.key, p.id]));
  let ownerRoleId = '';
  for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
    const role = await prisma.role.create({
      data: { tenantId: tenant.id, key, name: def.name, isSystem: true, permissions: { create: def.permissions.map((p) => ({ permissionId: permId.get(p)! })) } },
    });
    if (key === 'OWNER') ownerRoleId = role.id;
  }
  await prisma.tenantMember.create({ data: { tenantId: tenant.id, userId: user.id, roleId: ownerRoleId } });
  await prisma.storefrontSettings.create({ data: { tenantId: tenant.id, description: 'Lagos fashion, live every Friday on TikTok.', whatsappNumber: '+2348000000001', contactEmail: EMAIL } });
  const [storefront, manual] = await Promise.all([
    prisma.salesChannel.create({ data: { tenantId: tenant.id, type: 'STOREFRONT', name: 'Online store' } }),
    prisma.salesChannel.create({ data: { tenantId: tenant.id, type: 'TIKTOK_LIVE', name: 'TikTok Live', handle: '@adafashion' } }),
  ]);
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code: 'PROFESSIONAL' } });
  const trialEnd = new Date(now.getTime() + 10 * DAY);
  await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: 'TRIALING', currentPeriodStart: now, currentPeriodEnd: trialEnd, trialEndsAt: trialEnd } });

  const variants: Array<{ id: string; name: string; sku: string; price: bigint }> = [];
  for (const [code, name, price] of PRODUCTS) {
    const p = await prisma.product.create({ data: { tenantId: tenant.id, name, slug: code.toLowerCase(), productCode: code, status: 'ACTIVE' } });
    const v = await prisma.productVariant.create({ data: { tenantId: tenant.id, productId: p.id, sku: `${code}-STD`, name: 'Standard', priceMinor: price, isDefault: true } });
    await prisma.inventory.create({ data: { tenantId: tenant.id, variantId: v.id, onHand: 20 + Math.floor(rnd() * 60), reserved: Math.floor(rnd() * 4) } });
    variants.push({ id: v.id, name, sku: v.sku, price });
  }
  const customers = [];
  for (const [i, fullName] of NAMES.entries()) {
    customers.push(await prisma.customer.create({ data: { tenantId: tenant.id, fullName, phone: `+23480${String(10000000 + i * 7331).slice(0, 8)}`, createdAt: new Date(now.getTime() - (NAMES.length - i) * 9 * DAY) } }));
  }

  let orders = 0;
  for (let daysAgo = 420; daysAgo >= 0; daysAgo--) {
    const perDay = daysAgo < 30 ? Math.floor(rnd() * 4) : Math.floor(rnd() * 2.2);
    for (let k = 0; k < perDay; k++) {
      const at = new Date(now.getTime() - daysAgo * DAY - Math.floor(rnd() * 8) * 3_600_000);
      const v = pick(variants);
      const qty = 1 + Math.floor(rnd() * 2);
      const total = v.price * BigInt(qty);
      const roll = rnd();
      const [status, paymentStatus] =
        roll < 0.62 ? (['DELIVERED', 'PAID'] as const) : roll < 0.74 ? (['PAID', 'PAID'] as const) : roll < 0.8 ? (['DISPATCHED', 'PAID'] as const)
        : roll < 0.88 ? (['PENDING_PAYMENT', 'PENDING'] as const) : roll < 0.92 ? (['PAYMENT_VERIFICATION', 'AWAITING_VERIFICATION'] as const) : (['CANCELLED', 'UNPAID'] as const);
      const order = await prisma.order.create({
        data: {
          tenantId: tenant.id, reference: `LS-${(++orders).toString().padStart(6, '0')}`, customerId: pick(customers).id,
          channelId: rnd() < 0.6 ? manual.id : storefront.id, status, paymentStatus, subtotalMinor: total, totalMinor: total, createdAt: at,
          items: { create: { tenantId: tenant.id, variantId: v.id, productName: v.name, variantName: 'Standard', sku: v.sku, quantity: qty, unitPriceMinor: v.price, lineTotalMinor: total } },
        },
      });
      if (paymentStatus === 'PAID') {
        const provider = rnd() < 0.7 ? 'PAYSTACK' : 'BANK_TRANSFER';
        await prisma.paymentTransaction.create({
          data: {
            tenantId: tenant.id, purpose: 'ORDER', orderId: order.id, customerId: order.customerId, provider,
            reference: `DEMO-${randomUUID()}`, idempotencyKey: `demo-${randomUUID()}`, currency: 'NGN', grossMinor: total,
            status: 'SUCCEEDED', verifiedAt: new Date(at.getTime() + 20 * 60_000), verifiedBy: 'demo-seed', createdAt: at,
            // Bank transfers always carry the transfer report (DB check since Phase 7).
            ...(provider === 'BANK_TRANSFER' ? { settlementMode: 'BANK_TRANSFER' as const, transferEvidence: { payerName: 'Demo customer', payerReference: 'DEMO', submittedBy: 'demo-seed' } } : {}),
          },
        });
      }
    }
  }
  console.log(`Demo seller ready: ${EMAIL} / ${PASSWORD}  (${orders} orders) — development data only`);
}

main().finally(() => prisma.$disconnect());
