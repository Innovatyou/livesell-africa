/* eslint-disable no-console */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client';
import { PERMISSIONS } from '../src/rbac/permissions';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const naira = (n: number) => BigInt(n * 100); // minor units (kobo)

// Initial pricing proposal from the product brief — editable from the admin portal (Phase 11).
// Annual = 10× monthly (two months free); adjust before launch.
const PLANS = [
  {
    code: 'STARTER', name: 'Starter', sortOrder: 1, monthly: 5_000,
    limits: { products: 50, ordersPerMonth: 200, staff: 1, paymentGateways: 1 },
    features: { storefront: 'basic', orderManagement: 'basic', whatsappNotifications: false, analytics: false, inventory: 'basic' },
  },
  {
    code: 'PROFESSIONAL', name: 'Professional', sortOrder: 2, monthly: 12_000,
    limits: { products: 500, ordersPerMonth: 2_000, staff: 5, paymentGateways: 2 },
    features: { storefront: 'full', orderManagement: 'advanced', whatsappNotifications: true, analytics: 'standard', inventory: 'full' },
  },
  {
    code: 'BUSINESS', name: 'Business', sortOrder: 3, monthly: 25_000,
    limits: { products: 5_000, ordersPerMonth: 20_000, staff: 20, paymentGateways: 3 },
    features: { storefront: 'full', orderManagement: 'advanced', whatsappNotifications: true, analytics: 'advanced', inventory: 'advanced', customerSegmentation: true, automation: true },
  },
  {
    code: 'ENTERPRISE', name: 'Enterprise', sortOrder: 4, monthly: null,
    limits: { products: null, ordersPerMonth: null, staff: null, paymentGateways: null },
    features: { storefront: 'full', orderManagement: 'advanced', whatsappNotifications: true, analytics: 'advanced', dedicatedSupport: true, customIntegrations: true },
  },
] as const;

// Commission-based option: no fixed fee, a share of each verified sale. Rate and limits are PLACEHOLDERS for the
// business to confirm; both are editable from the admin API. Shown after the subscription plans.
// Full product, unlimited, no fixed fee (decided 2026-11-06): LiveSell earns the commission on every verified sale —
// at source for split payments, by a monthly commission invoice for sales the seller collects directly.
const COMMISSION_PLAN = {
  code: 'PAY_AS_YOU_SELL', name: 'Pay as you sell', sortOrder: 5, commissionBps: 300,
  description: 'Everything in LiveSell, no monthly fee. A commission on each verified sale.',
  limits: { products: null, ordersPerMonth: null, staff: null, paymentGateways: null },
  features: { storefront: 'full', orderManagement: 'advanced', whatsappNotifications: true, analytics: 'advanced', inventory: 'advanced', customerSegmentation: true, automation: true },
};

// Disabled + sandbox by default. Capabilities stay empty until verified against provider docs (Phase 5–7).
const PROVIDERS = [
  { code: 'PAYSTACK', name: 'Paystack' },
  { code: 'FLUTTERWAVE', name: 'Flutterwave' },
  { code: 'BACHS', name: 'Bachs' },
  { code: 'BANK_TRANSFER', name: 'Direct bank transfer' },
] as const;

async function main() {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, create: { key, description }, update: { description } });
  }

  for (const p of PLANS) {
    const data = {
      name: p.name, sortOrder: p.sortOrder, currency: 'NGN', trialDays: 14,
      monthlyPriceMinor: p.monthly == null ? null : naira(p.monthly),
      annualPriceMinor: p.monthly == null ? null : naira(p.monthly * 10),
      limits: p.limits, features: p.features,
    };
    // Never overwrite prices an admin has already edited.
    await prisma.subscriptionPlan.upsert({ where: { code: p.code }, create: { code: p.code, ...data }, update: {} });
  }

  await prisma.subscriptionPlan.upsert({
    where: { code: COMMISSION_PLAN.code },
    create: {
      code: COMMISSION_PLAN.code, name: COMMISSION_PLAN.name, description: COMMISSION_PLAN.description, sortOrder: COMMISSION_PLAN.sortOrder,
      currency: 'NGN', trialDays: 14, monthlyPriceMinor: 0n, annualPriceMinor: 0n, pricingModel: 'COMMISSION',
      commissionBps: COMMISSION_PLAN.commissionBps, limits: COMMISSION_PLAN.limits, features: COMMISSION_PLAN.features,
    },
    update: {},
  });

  for (const p of PROVIDERS) {
    await prisma.paymentProvider.upsert({
      where: { code: p.code },
      create: { code: p.code, name: p.name, isEnabled: p.code === 'BANK_TRANSFER', sandboxMode: true },
      update: {},
    });
  }

  // Defaults only; never overwrite values an admin has changed.
  const SETTINGS: Array<[string, unknown]> = [
    ['commission.default_bps', 0],
    ['commission.invoice_due_days', 7], // a monthly commission invoice is due this many days after it is issued
    ['commission.min_invoice_minor', 100000], // smaller amounts (₦1,000) carry over to the next month
    ['billing.grace_days', 3], // days a PAST_DUE subscription keeps access after its invoice falls due
    ['billing.reminder_days', [7, 3, 1]], // trial-ending / renewal reminder thresholds
    ['orders.staff_hold_hours', 48], // unpaid staff-created orders keep stock reserved this long
    ['orders.checkout_hold_minutes', 1440], // unpaid storefront orders (shorten once online payment exists, Phase 5)
    ['orders.transfer_hold_hours', 72], // stock stays reserved this long after a customer reports a bank transfer
    ['payments.transfer_stale_hours', 24], // reconciliation flags transfers still unverified after this long
    ['messaging.price_kobo', { EMAIL: 0, SMS: 400, WHATSAPP: 600 }], // charged to the seller per message (placeholders)
    ['messaging.monthly_limits', { EMAIL: 2000, SMS: 300, WHATSAPP: 500 }], // per seller per month; a plan's limits.messaging overrides
    ['whatsapp.templates', {}], // order event -> approved template { name, language }; set in Platform admin -> Integrations
  ];
  for (const [key, value] of SETTINGS) {
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value: value as object }, update: {} });
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    if (adminPassword.length < 16) throw new Error('SEED_ADMIN_PASSWORD must be at least 16 characters');
    await prisma.user.upsert({
      where: { email: adminEmail },
      create: {
        email: adminEmail, fullName: 'Platform Administrator', platformRole: 'PLATFORM_ADMIN', status: 'ACTIVE',
        emailVerifiedAt: new Date(), passwordHash: await argon2.hash(adminPassword, { type: argon2.argon2id }),
      },
      update: { platformRole: 'PLATFORM_ADMIN' },
    });
    console.log(`Platform admin ensured: ${adminEmail}`);
  }
  console.log('Seed complete');
}

main().finally(() => prisma.$disconnect());
