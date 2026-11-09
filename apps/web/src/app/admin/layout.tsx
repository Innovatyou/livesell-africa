'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Alert, Button, Logo, PageLoading } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const NAV: Array<[string, string]> = [['/admin', 'Overview'], ['/admin/sellers', 'Sellers'], ['/admin/verifications', 'Verification'], ['/admin/plans', 'Plans'], ['/admin/payments', 'Payments'], ['/admin/integrations', 'Integrations'], ['/admin/audit', 'Audit log'], ['/admin/settings', 'Settings']];

/** Platform administration (LiveSell staff only). The API enforces the platform role on every admin route. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { status, me, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (status === 'anonymous') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, pathname, router]);

  if (status !== 'authenticated' || !me) return <PageLoading label="Loading" />;
  if (me.platformRole === 'NONE') {
    return (
      <div className="mx-auto max-w-md px-4 py-20">
        <Logo />
        <Alert tone="warn" title="Platform administrators only" className="mt-6">This area is for the LiveSell team.</Alert>
        <Link href="/dashboard" className="mt-4 inline-block text-sm text-brand-700 hover:underline">Back to my store</Link>
      </div>
    );
  }
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-4"><Logo /><span className="rounded bg-sunken px-2 py-0.5 text-[12px] font-medium text-ink-2">Platform admin</span></div>
          <nav aria-label="Admin" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} aria-current={(href === '/admin' ? pathname === href : pathname.startsWith(href)) ? 'page' : undefined}
                className={pathname === href || (href !== '/admin' && pathname.startsWith(href)) ? 'font-semibold text-brand-700' : 'hover:text-brand-700'}>{label}</Link>
            ))}
            <Link href="/dashboard" className="text-ink-3 hover:text-ink">My store</Link>
            <Button size="sm" variant="ghost" onClick={() => void logout()}>Sign out</Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
