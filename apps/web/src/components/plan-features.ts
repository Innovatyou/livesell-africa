import type { Plan } from '@/lib/types';

/** Human-readable plan bullets derived from the plan's admin-editable limits and feature flags. */
const FEATURE_LABELS: Record<string, (v: boolean | string) => string | null> = {
  storefront: (v) => (v === 'basic' ? 'Basic storefront' : v ? 'Full storefront' : null),
  orderManagement: (v) => (v === 'advanced' ? 'Advanced order management' : v ? 'Order management' : null),
  whatsappNotifications: (v) => (v ? 'WhatsApp notifications' : null),
  analytics: (v) => (v === 'advanced' ? 'Advanced analytics, PDF and emailed reports' : v ? 'Sales analytics (up to 3 months)' : null),
  inventory: (v) => (v === 'advanced' ? 'Advanced inventory' : v === 'full' ? 'Inventory management' : v ? 'Basic inventory' : null),
  customerSegmentation: (v) => (v ? 'Customer segmentation' : null),
  automation: (v) => (v ? 'Advanced automation' : null),
  dedicatedSupport: (v) => (v ? 'Dedicated support' : null),
  customIntegrations: (v) => (v ? 'Custom integrations' : null),
};

const n = (v: number) => v.toLocaleString('en-NG');

export function planBullets(plan: Pick<Plan, 'limits' | 'features'>): string[] {
  const l = plan.limits;
  const out: string[] = [
    l.products === null ? 'Unlimited products' : `Up to ${n(l.products)} products`,
    l.ordersPerMonth === null ? 'Unlimited orders' : `${n(l.ordersPerMonth)} orders / month`,
    l.staff === null ? 'Unlimited team members' : l.staff === 1 ? 'Owner account only' : `${n(l.staff)} team members`,
  ];
  if (l.paymentGateways === null) out.push('All payment gateways');
  else if (l.paymentGateways > 1) out.push(`${l.paymentGateways} payment gateways`);
  for (const [key, value] of Object.entries(plan.features ?? {})) {
    const label = FEATURE_LABELS[key]?.(value);
    if (label) out.push(label);
  }
  return out;
}
