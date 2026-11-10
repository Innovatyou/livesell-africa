'use client';

import Link from 'next/link';
import { ThemeToggle } from './theme-toggle';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Alert, Button, ButtonLink, Logo, PageLoading, Select, cx } from './ui';

interface NavItem { href: string; label: string; icon: string; permission?: string }
const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z' },
  { href: '/onboarding', label: 'Setup checklist', icon: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9' },
  { href: '/orders', label: 'Orders', icon: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4', permission: 'orders:read' },
  { href: '/deliveries', label: 'Deliveries', icon: 'M3 7h11v9H3V7Zm11 3h4l3 3v3h-7v-6ZM7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', permission: 'orders:read' },
  { href: '/analytics', label: 'Analytics', icon: 'M4 20V10m6 10V4m6 16v-7m4 7H2', permission: 'reports:read' },
  { href: '/live', label: 'Live selling', icon: 'M15 10l4.6-2.3A1 1 0 0 1 21 8.6v6.8a1 1 0 0 1-1.4.9L15 14M5 18h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2Z', permission: 'live:read' },
  { href: '/products', label: 'Products', icon: 'M20 7 12 3 4 7m16 0-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4', permission: 'products:read' },
  { href: '/inventory', label: 'Inventory', icon: 'M3 3v18h18M7 15l3-3 3 3 5-6', permission: 'inventory:read' },
  { href: '/customers', label: 'Customers', icon: 'M17 20h5v-2a4 4 0 0 0-5-3.9M9 20H4v-2a4 4 0 0 1 5-3.9m8-6.1a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-9 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0', permission: 'customers:read' },
  { href: '/settings/storefront', label: 'Storefront', icon: 'M4 4h16v6H4zM6 10v10h12V10M10 14h4' },
  { href: '/settings/store', label: 'Store profile', icon: 'M3 9l1.5-5h15L21 9M3 9h18M3 9v11h18V9M9 20v-6h6v6' },
  { href: '/settings/team', label: 'Team', icon: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm13 9v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8', permission: 'staff:manage' },
  { href: '/settings/delivery', label: 'Delivery', icon: 'M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', permission: 'orders:read' },
  { href: '/settings/payments', label: 'Payments', icon: 'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7Zm0 3h20M6 15h4', permission: 'payments:read' },
  { href: '/settings/messaging', label: 'Messaging', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z', permission: 'reports:read' },
  { href: '/settings/billing', label: 'Plan & billing', icon: 'M3 7h18v10H3V7Zm0 4h18M7 15h3', permission: 'billing:manage' },
  { href: '/settings/verification', label: 'Business verification', icon: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Zm-3 9 2 2 4-4', permission: 'store:manage' },
];

const DAY = 86_400_000;

export function AppShell({ children }: { children: React.ReactNode }) {
  const { status, me, workspace, logout, selectTenant, can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (status === 'anonymous') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, pathname, router]);
  useEffect(() => setOpen(false), [pathname]);

  if (status !== 'authenticated' || !me) return <PageLoading label="Loading your workspace" />;

  if (!workspace) {
    return (
      <div className="mx-auto max-w-md px-4 py-20">
        <Logo />
        <Alert tone="warn" title="You're not part of any store yet" className="mt-6">
          Ask a store owner to invite you, or create your own store with a different email address.
        </Alert>
        <Button variant="secondary" className="mt-4" onClick={() => void logout()}>Sign out</Button>
      </div>
    );
  }

  const items = NAV.filter((i) => !i.permission || can(i.permission));
  // LiveSell staff get a way into the platform admin area; the API enforces the platform role on every admin route.
  if (me.platformRole !== 'NONE') items.push({ href: '/admin', label: 'Platform admin', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.2-1.3L14.4 3h-4l-.3 2.4a7.6 7.6 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.2 1.3l.3 2.4h4l.3-2.4a7.6 7.6 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z' });
  const nav = (
    <nav aria-label="App" className="flex flex-col gap-0.5">
      {items.map((i) => {
        const active = pathname === i.href || pathname.startsWith(`${i.href}/`);
        return (
          <Link
            key={i.href} href={i.href} aria-current={active ? 'page' : undefined}
            className={cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors', active ? 'bg-brand-50 font-medium text-brand-800' : 'text-ink-2 hover:bg-sunken hover:text-ink')}
          >
            <svg aria-hidden viewBox="0 0 24 24" className={cx('size-[18px] shrink-0', active ? 'text-brand-700' : 'text-ink-3')} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d={i.icon} /></svg>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <Link href="/dashboard" className="px-2 pt-1"><Logo /></Link>
      {me.memberships.length > 1 ? (
        <label className="block px-1">
          <span className="sr-only">Switch store</span>
          <Select value={workspace.id} onChange={(e) => void selectTenant(e.target.value)}>
            {me.memberships.map((m) => <option key={m.tenant.id} value={m.tenant.id}>{m.tenant.businessName}</option>)}
          </Select>
        </label>
      ) : (
        <div className="px-3">
          <p className="truncate text-sm font-semibold text-ink">{workspace.businessName}</p>
          <p className="truncate text-xs text-ink-3">livesell.africa/store/{workspace.slug}</p>
        </div>
      )}
      {nav}
      <div className="mt-auto border-t border-line px-1 pt-4">
        <p className="truncate px-2 text-sm font-medium text-ink">{me.fullName}</p>
        <p className="truncate px-2 text-xs text-ink-3">{me.email} · {roleLabel(workspace.role)}</p>
        <ThemeToggle className="mx-2 mt-3" />
        <Button variant="ghost" size="sm" className="mt-2 w-full justify-start" onClick={() => void logout()}>Sign out</Button>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="hidden print:!hidden border-r border-line bg-surface lg:sticky lg:top-0 lg:block lg:h-dvh">{sidebar}</aside>

      <header className="sticky top-0 z-30 flex h-14 print:hidden items-center justify-between border-b border-line bg-surface px-4 lg:hidden">
        <Link href="/dashboard"><Logo /></Link>
        <button className="grid size-10 place-items-center rounded-md text-ink-2" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button className="absolute inset-0 bg-ink/30" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[82%] max-w-[300px] overflow-y-auto bg-surface shadow-[var(--shadow-pop)]">{sidebar}</div>
        </div>
      )}

      <div className="min-w-0">
        <div className="print:hidden"><SubscriptionBanner /></div>
        <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}

function roleLabel(key: string) {
  return { OWNER: 'Owner', STORE_MANAGER: 'Store manager', SALES_ASSISTANT: 'Sales assistant', LIVE_MODERATOR: 'Live moderator' }[key] ?? key;
}

function SubscriptionBanner() {
  const { workspace, can } = useAuth();
  if (!workspace) return null;
  const sub = workspace.subscriptions[0];
  const billing = can('billing:manage');
  const cta = billing ? <ButtonLink href="/settings/billing" size="sm" variant="secondary">View plans</ButtonLink> : undefined;
  const wrap = (node: React.ReactNode) => <div className="mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6">{node}</div>;

  if (!sub) {
    return wrap(
      <Alert tone="bad" title="Your subscription has ended" action={cta}>
        Your data is safe and you can still view it, but changes are paused until {billing ? 'you choose a plan' : 'the owner renews the plan'}.
      </Alert>,
    );
  }
  if (sub.status === 'PAST_DUE') {
    return wrap(
      <Alert tone="warn" title="Payment due" action={cta}>
        Your {sub.plan.name} invoice is open. Keep your store running by settling it from Plan &amp; billing.
      </Alert>,
    );
  }
  if (sub.status === 'TRIALING' && sub.trialEndsAt) {
    const days = Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / DAY));
    if (days <= 7) {
      return wrap(
        <Alert tone="info" title={`Your free trial ends in ${days} day${days === 1 ? '' : 's'}`} action={cta}>
          You&apos;re on the {sub.plan.name} trial.
        </Alert>,
      );
    }
  }
  return null;
}
