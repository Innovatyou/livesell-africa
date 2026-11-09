'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { SalesChart } from '@/components/sales-chart';
import { Alert, Badge, ButtonLink, Card, CardHeader, EmptyState, ErrorState, Skeleton, cx } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { formatCount, formatMoney } from '@/lib/money';
import type { ChartPeriod, Checklist, DashboardSummary, SalesChart as Chart } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const PERIODS: Array<[ChartPeriod, string]> = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
const TX_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { SUCCEEDED: 'good', PENDING: 'warn', INITIALIZED: 'neutral', FAILED: 'bad', ABANDONED: 'neutral', REVERSED: 'bad' };
const TX_LABEL: Record<string, string> = { SUCCEEDED: 'Verified', PENDING: 'Pending', INITIALIZED: 'Started', FAILED: 'Failed', ABANDONED: 'Abandoned', REVERSED: 'Reversed' };

const dateTime = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' }).format(new Date(s));

export default function DashboardPage() {
  const { can, workspace } = useAuth();
  const allowed = can('reports:read');
  const checklist = useApi<Checklist>('/onboarding');
  const summary = useApi<DashboardSummary>(allowed ? '/dashboard/summary' : null);
  const [period, setPeriod] = useState<ChartPeriod>('daily');
  const chart = useApi<Chart>(allowed ? `/dashboard/sales?period=${period}` : null);

  const setup = checklist.data && checklist.data.requiredRemaining > 0 && (
    <Alert tone="info" title={`Finish setting up your store — ${checklist.data.requiredRemaining} step${checklist.data.requiredRemaining === 1 ? '' : 's'} left`} action={<ButtonLink href="/onboarding" size="sm" variant="secondary">Continue</ButtonLink>} className="mb-6">
      {checklist.data.completed} of {checklist.data.total} done.
    </Alert>
  );

  if (!allowed) {
    return (
      <>
        <PageHeader title="Dashboard" description={workspace?.businessName} />
        {setup}
        <Card><EmptyState title="Sales reports aren't part of your role">Your store owner or manager can see sales figures. Products, orders and live sessions will appear in your menu as they launch.</EmptyState></Card>
      </>
    );
  }

  const s = summary.data;
  const cur = s?.currency ?? workspace?.defaultCurrency ?? 'NGN';
  const noSales = s && s.totalOrders === 0 && s.recentTransactions.length === 0;

  return (
    <>
      <PageHeader title="Dashboard" description={`Sales figures use verified payments only · times in West Africa Time`} />
      {setup}
      {summary.error && <div className="mb-6"><ErrorState message={summary.error} onRetry={summary.reload} /></div>}

      <section aria-label="Key figures" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sales today" value={s && formatMoney(s.salesTodayMinor, cur)} emphasis />
        <Stat label="Sales this month" value={s && formatMoney(s.salesThisMonthMinor, cur)} emphasis />
        <Stat label="Average order value" value={s && formatMoney(s.averageOrderValueMinor, cur)} />
        <Stat label="Pending payments" value={s && formatCount(s.pendingPayments.count)} sub={s && `${formatMoney(s.pendingPayments.amountMinor, cur)} awaiting`} />
        <Stat label="Total orders" value={s && formatCount(s.totalOrders)} />
        <Stat label="Paid orders" value={s && formatCount(s.paidOrders)} />
        <Stat label="Outstanding orders" value={s && formatCount(s.outstandingOrders)} sub="Paid, not yet delivered" />
        <Stat label="Cancelled orders" value={s && formatCount(s.cancelledOrders)} />
        <Stat label="Products sold" value={s && formatCount(s.productsSold)} />
        <Stat label="Available inventory" value={s && formatCount(s.availableInventory)} sub="Units in stock, not reserved" />
      </section>

      {noSales && (
        <Alert tone="info" className="mt-6" title="No sales yet">
          Your figures fill in automatically from real orders and verified payments. Product listings, orders and payments are switching on in the next releases.
        </Alert>
      )}

      <Card className="mt-6">
        <CardHeader
          title="Sales"
          description={chart.data ? `${formatMoney(chart.data.totalMinor, cur)} in this view` : 'Verified payments'}
          action={
            <div role="tablist" aria-label="Chart period" className="inline-flex rounded-lg border border-line bg-sunken p-0.5">
              {PERIODS.map(([p, label]) => (
                <button key={p} role="tab" aria-selected={period === p} onClick={() => setPeriod(p)}
                  className={cx('rounded-md px-3 py-1 text-[13px] font-medium', period === p ? 'bg-surface text-ink shadow-[var(--shadow-card)]' : 'text-ink-3 hover:text-ink')}>
                  {label}
                </button>
              ))}
            </div>
          }
        />
        <div className="p-4 sm:p-5">
          {chart.error ? <ErrorState message={chart.error} onRetry={chart.reload} /> : chart.data && !chart.loading ? <SalesChart data={chart.data} /> : <Skeleton className="h-[260px] w-full" />}
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Top-selling products" description="By units sold in paid orders" />
          {!s ? <ListSkeleton /> : s.topProducts.length === 0 ? (
            <EmptyState title="No products sold yet">Best sellers appear here after your first paid orders.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {s.topProducts.map((p) => (
                <li key={p.productId} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="text-[12px] text-ink-3">{p.productCode}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium tabular">{formatCount(p.quantity)} sold</p>
                    <p className="text-[12px] text-ink-3 tabular">{formatMoney(p.revenueMinor, cur)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Recent customers" />
          {!s ? <ListSkeleton /> : s.recentCustomers.length === 0 ? (
            <EmptyState title="No customers yet">Customers are added when they place their first order.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {s.recentCustomers.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-50 text-[12px] font-semibold text-brand-700">
                      {c.fullName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.fullName}</p>
                      <p className="truncate text-[12px] text-ink-3">{c.phone ?? c.email ?? '—'}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm tabular">{formatMoney(c.totalSpentMinor, cur)}</p>
                    <p className="text-[12px] text-ink-3">{c.orderCount} order{c.orderCount === 1 ? '' : 's'}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Recent transactions" description="Customer payments for orders" />
        {!s ? <ListSkeleton /> : s.recentTransactions.length === 0 ? (
          <EmptyState title="No transactions yet">Payments appear here as customers pay for orders.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3">
                <tr className="border-b border-line">
                  <th className="px-5 py-2.5 font-medium">Reference</th><th className="px-5 py-2.5 font-medium">Order</th>
                  <th className="px-5 py-2.5 font-medium">Method</th><th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 text-right font-medium">Amount</th><th className="px-5 py-2.5 text-right font-medium">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.recentTransactions.map((t) => (
                  <tr key={t.id}>
                    <td className="px-5 py-3 font-mono text-[12px] text-ink-2">{t.reference}</td>
                    <td className="px-5 py-3 text-ink-2">{t.order?.reference ?? '—'}</td>
                    <td className="px-5 py-3 text-ink-2">{t.provider.replace('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</td>
                    <td className="px-5 py-3"><Badge tone={TX_TONE[t.status] ?? 'neutral'}>{TX_LABEL[t.status] ?? t.status}</Badge></td>
                    <td className="px-5 py-3 text-right tabular">{formatMoney(t.grossMinor, t.currency)}</td>
                    <td className="px-5 py-3 text-right text-ink-3">{dateTime(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function Stat({ label, value, sub, emphasis }: { label: string; value: string | null | undefined; sub?: string | null; emphasis?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-[13px] text-ink-3">{label}</p>
      {value == null ? <Skeleton className="mt-2 h-7 w-24" /> : (
        <p className={cx('mt-1 font-semibold tracking-tight tabular text-ink', emphasis ? 'text-2xl' : 'text-xl')}>{value}</p>
      )}
      {sub && value != null && <p className="mt-0.5 text-[12px] text-ink-3">{sub}</p>}
    </Card>
  );
}

function ListSkeleton() {
  return <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>;
}
