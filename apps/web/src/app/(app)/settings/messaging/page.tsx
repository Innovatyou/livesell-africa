'use client';

import { MessagePreferencesCard } from '@/components/message-preferences';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageLoading } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { CHANNEL_LABEL, failureReason, NOTIFICATION_STATUS, usedPercent } from '@/lib/messaging-labels';
import { formatMoney } from '@/lib/money';
import type { MessagingUsage, NotificationList } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));

/** MASTER-SPEC §15 messaging usage: what LiveSell sent on the store's behalf this month, limits and cost. */
export default function MessagingPage() {
  const { can } = useAuth();
  const allowed = can('reports:read');
  const manage = can('store:manage');
  const usage = useApi<MessagingUsage>(allowed ? '/messaging/usage' : null);
  const list = useApi<NotificationList>(allowed ? '/messaging/notifications?pageSize=25' : null);

  if (!allowed && manage) return <div className="mx-auto max-w-4xl space-y-6"><PageHeader title="Messaging" description="Automatic WhatsApp, SMS and email updates to your customers." /><MessagePreferencesCard /></div>;
  if (!allowed) return <Card><EmptyState title="You don’t have access to messaging reports" /></Card>;
  if (usage.error) return <ErrorState message={usage.error} onRetry={usage.reload} />;
  if (!usage.data) return <PageLoading />;
  const u = usage.data;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Messaging" description={`WhatsApp, SMS and email LiveSell sends to your customers for your store, this month (${u.period}).`} />

      <section aria-label="Usage this month" className="grid gap-3 sm:grid-cols-3">
        {u.channels.map((c) => {
          const pct = usedPercent(c.sent + c.queued, c.limit);
          return (
            <Card key={c.channel} className="space-y-2 p-4">
              <div className="flex items-center justify-between"><p className="font-medium">{CHANNEL_LABEL[c.channel]}</p>{!c.enabled && <Badge>Not available yet</Badge>}</div>
              <p className="text-2xl font-semibold tabular">{c.sent}<span className="text-sm font-normal text-ink-3"> / {c.limit}</span></p>
              <div className="h-1.5 rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${CHANNEL_LABEL[c.channel]} limit used`}>
                <div className={`h-1.5 rounded-full ${pct >= 90 ? 'bg-bad' : pct >= 70 ? 'bg-warn' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} />
              </div>
              <p className="text-[13px] text-ink-3">{c.delivered ? `${c.delivered} delivered · ` : ''}{c.failed ? `${c.failed} failed · ` : ''}{formatMoney(c.costMinor, u.currency)}</p>
            </Card>
          );
        })}
      </section>
      {manage && <MessagePreferencesCard />}

      <p className="text-sm text-ink-2">Messaging cost this month: <span className="font-semibold tabular">{formatMoney(u.totalCostMinor, u.currency)}</span>. When a monthly limit is reached, further messages on that channel are not sent until next month.</p>

      <Card>
        <CardHeader title="Recent messages" />
        {list.error ? <div className="p-5"><ErrorState message={list.error} onRetry={list.reload} /></div>
          : !list.data ? <PageLoading />
          : list.data.items.length === 0 ? <EmptyState title="No messages yet">Order and payment updates sent to your customers will appear here.</EmptyState>
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3"><tr className="border-b border-line"><th className="px-5 py-2.5 font-medium">Message</th><th className="px-5 py-2.5 font-medium">To</th><th className="px-5 py-2.5 font-medium">Status</th><th className="px-5 py-2.5 text-right font-medium">Cost</th><th className="px-5 py-2.5 text-right font-medium">When</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {list.data.items.map((n) => (
                    <tr key={n.id}>
                      <td className="px-5 py-3">{CHANNEL_LABEL[n.channel]} · {n.type.replace(/_/g, ' ').toLowerCase()}</td>
                      <td className="px-5 py-3 font-mono text-[12px]">{n.destination}</td>
                      <td className="px-5 py-3"><Badge tone={NOTIFICATION_STATUS[n.status][1]}>{NOTIFICATION_STATUS[n.status][0]}</Badge>{n.status === 'FAILED' && <span className="ml-2 text-[12px] text-ink-3">{failureReason(n.error)}</span>}</td>
                      <td className="px-5 py-3 text-right tabular">{n.costMinor ? formatMoney(n.costMinor) : '—'}</td>
                      <td className="px-5 py-3 text-right text-ink-3">{when(n.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </div>
  );
}
