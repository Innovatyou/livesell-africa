'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Badge, ButtonLink, Card, EmptyState, ErrorState, Skeleton, cx } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money';
import { LIVE_BADGE } from '@/lib/order-labels';
import type { LiveSessionListItem, Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const when = (s: string) => new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));

export default function LivePage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const list = useApi<Page<LiveSessionListItem>>(can('live:read') ? `/live-sessions?when=${tab}` : null);
  if (!can('live:read')) return <Card><EmptyState title="Your role can't view live sessions" /></Card>;
  return (
    <>
      <PageHeader title="Live selling" description="Plan your lives, take orders by product code, and see what each live sold."
        action={can('live:manage') && <ButtonLink href="/live/new" size="sm">Schedule a live</ButtonLink>} />
      <div role="tablist" className="mb-4 flex gap-1">
        {(['upcoming', 'past'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cx('rounded-full border px-3 py-1.5 text-sm capitalize', tab === t ? 'border-brand-500 bg-brand-50 font-medium text-brand-800' : 'border-line bg-surface text-ink-2')}>{t}</button>
        ))}
      </div>
      <Card>
        {list.error ? <div className="p-5"><ErrorState message={list.error} onRetry={list.reload} /></div>
          : !list.data ? <div className="space-y-3 p-5"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
          : list.data.items.length === 0 ? <EmptyState title={tab === 'upcoming' ? 'No lives planned' : 'No past lives'} action={tab === 'upcoming' && can('live:manage') ? <ButtonLink href="/live/new">Schedule a live</ButtonLink> : undefined}>Schedule a session, pick the products you’ll show, and take orders with their codes.</EmptyState>
          : (
            <ul className="divide-y divide-line">
              {list.data.items.map((s) => (
                <li key={s.id}>
                  <Link href={`/live/${s.id}`} className="flex flex-col gap-2 px-5 py-4 hover:bg-sunken/50 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="flex items-center gap-2 font-medium">{s.title} <Badge tone={LIVE_BADGE[s.status][0]}>{LIVE_BADGE[s.status][1]}</Badge></p>
                      <p className="text-[13px] text-ink-3">{s.channel.name} · {when(s.scheduledAt)} · {s._count.products} product{s._count.products === 1 ? '' : 's'}</p>
                    </div>
                    <div className="text-right text-sm">
                      <p className="font-semibold tabular">{formatMoney(s.revenueMinor)}</p>
                      <p className="text-[12px] text-ink-3">{s.paidOrders} paid of {s._count.orders} order{s._count.orders === 1 ? '' : 's'}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </>
  );
}
