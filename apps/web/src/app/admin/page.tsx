'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Badge, EmptyState, ErrorState, PageLoading } from '@/components/ui';
import { Section, Stat, useAdmin, when } from '@/components/admin-ui';
import { CHANNEL_LABEL } from '@/lib/messaging-labels';
import { formatBps, formatCount, formatMoney } from '@/lib/money';

interface Overview {
  sellers: { total: number; active: number; inactive: number; suspended: number; closed: number; newLast30Days: number };
  signups: Array<{ day: string; count: number }>;
  orders: { total: number };
  transactionVolume: Array<{ currency: string; grossMinor: string; payments: number }>;
  revenue: { currency: string; subscriptionRevenueMinor: string; commissionRevenueMinor: string; commissionReceivableMinor: string };
  gateways: Array<{ provider: string; started: number; succeeded: number; failed: number; abandoned: number; pending: number; successBps: number | null; volumeMinor: string }>;
  subscriptions: { byStatus: Array<{ status: string; count: number }>; byPlan: Array<{ plan: string; code: string | null; count: number }> };
  messaging: Array<{ channel: string; status: string; count: number }>;
  topSellers: Array<{ tenantId: string; businessName: string; slug: string; grossMinor: string; payments: number }>;
  problems: { failedWebhooks30d: number; failedMessages24h: number };
  health: { database: { status: 'up' | 'down'; ms: number }; redis: { status: 'up' | 'down'; ms: number }; stuckOutboxEvents: number; queuedMessages: number; checkedAt: string };
}

/** MASTER-SPEC §21 platform overview. Real data only. */
export default function AdminOverview() {
  const res = useAdmin<Overview>('/admin/overview');
  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (!res.data) return <PageLoading />;
  const o = res.data;
  const ngn = o.transactionVolume.find((v) => v.currency === 'NGN');
  const channels = [...new Set(o.messaging.map((m) => m.channel))];
  const h = o.health;
  const problems = o.problems.failedWebhooks30d + o.problems.failedMessages24h + h.stuckOutboxEvents + (h.database.status === 'down' ? 1 : 0) + (h.redis.status === 'down' ? 1 : 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Platform overview" description="All stores, all time unless stated. Paid means the payment was verified." />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sellers" value={formatCount(o.sellers.total)} hint={`${o.sellers.active} active · ${o.sellers.inactive} inactive · ${o.sellers.suspended} suspended`} />
        <Stat label="New sellers (30 days)" value={formatCount(o.sellers.newLast30Days)} />
        <Stat label="Orders" value={formatCount(o.orders.total)} />
        <Stat label="Transaction volume" value={formatMoney(ngn?.grossMinor ?? '0')} hint={`${formatCount(ngn?.payments ?? 0)} verified payments`} />
        <Stat label="Subscription revenue" value={formatMoney(o.revenue.subscriptionRevenueMinor)} />
        <Stat label="Commission earned" value={formatMoney(o.revenue.commissionRevenueMinor)} />
        <Stat label="Commission owed by sellers" value={<Link className="hover:text-brand-700" href="/admin/payments">{formatMoney(o.revenue.commissionReceivableMinor)}</Link>} />
        <Stat label="System" value={<Badge tone={problems ? 'warn' : 'good'}>{problems ? `${problems} to look at` : 'Healthy'}</Badge>} hint={`DB ${h.database.status} (${h.database.ms} ms) · Redis ${h.redis.status} (${h.redis.ms} ms)`} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Payment gateways (30 days)" description="Payments started on each gateway and how many were verified.">
          {o.gateways.length === 0 ? <EmptyState title="No online payments yet" /> : (
            <table className="w-full text-sm"><thead className="text-left text-[12px] uppercase text-ink-3"><tr className="border-b border-line"><th className="px-5 py-2">Gateway</th><th className="px-3 py-2 text-right">Started</th><th className="px-3 py-2 text-right">Verified</th><th className="px-3 py-2 text-right">Failed</th><th className="px-5 py-2 text-right">Success</th></tr></thead>
              <tbody className="divide-y divide-line">{o.gateways.map((g) => (
                <tr key={g.provider}><td className="px-5 py-2.5 font-medium">{g.provider}</td><td className="px-3 py-2.5 text-right tabular">{g.started}</td><td className="px-3 py-2.5 text-right tabular">{g.succeeded}</td><td className="px-3 py-2.5 text-right tabular">{g.failed}</td><td className="px-5 py-2.5 text-right tabular">{g.successBps === null ? '—' : formatBps(g.successBps)}</td></tr>
              ))}</tbody></table>
          )}
        </Section>

        <Section title="Top sellers (30 days)" description="By verified sales.">
          {o.topSellers.length === 0 ? <EmptyState title="No verified sales yet" /> : (
            <ol className="divide-y divide-line">{o.topSellers.map((s, i) => (
              <li key={s.tenantId} className="flex justify-between px-5 py-2.5 text-sm"><Link href={`/admin/sellers/${s.tenantId}`} className="hover:text-brand-700"><span className="mr-2 text-ink-3">{i + 1}.</span>{s.businessName}</Link><span className="tabular">{formatMoney(s.grossMinor)}</span></li>
            ))}</ol>
          )}
        </Section>

        <Section title="Subscriptions">
          <div className="grid gap-4 p-5 text-sm sm:grid-cols-2">
            <ul className="space-y-1">{o.subscriptions.byStatus.map((s) => <li key={s.status} className="flex justify-between"><span>{s.status.replace('_', ' ').toLowerCase()}</span><span className="tabular">{s.count}</span></li>)}</ul>
            <ul className="space-y-1">{o.subscriptions.byPlan.map((s) => <li key={s.plan} className="flex justify-between"><span>{s.plan}</span><span className="tabular">{s.count}</span></li>)}</ul>
          </div>
        </Section>

        <Section title="Messaging (30 days)" action={<Link href="/admin/integrations" className="text-sm text-brand-700">Details</Link>}>
          {channels.length === 0 ? <EmptyState title="No messages yet" /> : (
            <ul className="divide-y divide-line">{channels.map((c) => {
              const rows = o.messaging.filter((m) => m.channel === c);
              const n = (s: string) => rows.find((r) => r.status === s)?.count ?? 0;
              return <li key={c} className="flex justify-between px-5 py-2.5 text-sm"><span>{CHANNEL_LABEL[c] ?? c}</span><span className="text-ink-2">{n('SENT') + n('DELIVERED')} sent · {n('FAILED')} failed · {n('QUEUED')} retrying</span></li>;
            })}</ul>
          )}
        </Section>
      </div>

      <Section title="Problems" description={`Checked ${when(h.checkedAt)}`}>
        <ul className="divide-y divide-line text-sm">
          <li className="flex justify-between px-5 py-2.5"><Link href="/admin/settings#webhooks" className="hover:text-brand-700">Failed or unsigned payment webhooks (30 days)</Link><Badge tone={o.problems.failedWebhooks30d ? 'warn' : 'good'}>{o.problems.failedWebhooks30d}</Badge></li>
          <li className="flex justify-between px-5 py-2.5"><Link href="/admin/integrations" className="hover:text-brand-700">Failed messages (24 hours)</Link><Badge tone={o.problems.failedMessages24h ? 'warn' : 'good'}>{o.problems.failedMessages24h}</Badge></li>
          <li className="flex justify-between px-5 py-2.5"><span>Order events waiting over 10 minutes (job queue)</span><Badge tone={h.stuckOutboxEvents ? 'bad' : 'good'}>{h.stuckOutboxEvents}</Badge></li>
          <li className="flex justify-between px-5 py-2.5"><span>Messages waiting for a retry</span><Badge tone="neutral">{h.queuedMessages}</Badge></li>
        </ul>
      </Section>
    </div>
  );
}
