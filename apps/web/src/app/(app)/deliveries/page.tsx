'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Badge, Button, ButtonLink, Card, EmptyState, ErrorState, PageLoading, cx } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { DELIVERY_METHOD, DELIVERY_STATUS } from '@/lib/delivery-labels';
import { formatMoney } from '@/lib/money';
import type { DeliveryBoardItem, DeliveryStatus, Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const TABS: Array<[DeliveryStatus | '', string]> = [['PENDING', 'To send'], ['ASSIGNED', 'Rider assigned'], ['IN_TRANSIT', 'On the way'], ['FAILED', 'Problems'], ['DELIVERED', 'Delivered'], ['RETURNED', 'Returned'], ['', 'All paid']];
const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));

/** Dispatch board (MASTER-SPEC §18): paid orders by delivery status. */
export default function DeliveriesPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<DeliveryStatus | ''>('PENDING');
  const [page, setPage] = useState(1);
  const list = useApi<Page<DeliveryBoardItem>>(can('orders:read') ? `/deliveries?page=${page}&pageSize=25${tab ? `&status=${tab}` : ''}` : null);
  if (!can('orders:read')) return <Card><EmptyState title="Your role can’t view deliveries" /></Card>;
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  return (
    <>
      <PageHeader title="Deliveries" description="Paid orders and where they are. Open an order to record the courier, tracking number and status."
        action={can('delivery:manage') && <ButtonLink href="/settings/delivery" size="sm" variant="secondary">Zones & pickup</ButtonLink>} />
      <div role="tablist" aria-label="Delivery status" className="mb-4 flex gap-1 overflow-x-auto pb-1">
        {TABS.map(([k, l]) => (
          <button key={k || 'all'} role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setPage(1); }}
            className={cx('whitespace-nowrap rounded-full border px-3 py-1.5 text-sm', tab === k ? 'border-brand-500 bg-brand-50 font-medium text-brand-800' : 'border-line bg-surface text-ink-2 hover:text-ink')}>{l}</button>
        ))}
      </div>
      <Card>
        {list.error ? <div className="p-5"><ErrorState message={list.error} onRetry={list.reload} /></div>
          : !list.data ? <PageLoading />
          : list.data.items.length === 0 ? <EmptyState title={tab === 'PENDING' ? 'Nothing waiting to be sent' : 'No deliveries here'}>{tab === 'PENDING' ? 'Paid orders that haven’t gone out yet appear here.' : undefined}</EmptyState>
          : (
            <ul className="divide-y divide-line">
              {list.data.items.map((o) => {
                const st = o.delivery?.status ?? 'PENDING';
                const pickup = o.delivery?.method === 'PICKUP' || (!o.delivery && !o.shippingAddress);
                return (
                  <li key={o.id}>
                    <Link href={`/orders/${o.id}`} className="flex flex-col gap-1 px-5 py-3 text-sm hover:bg-sunken sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p><span className="font-mono font-medium">{o.reference}</span> <span className="text-ink-2">· {o.customer?.fullName ?? 'No customer'}</span></p>
                        <p className="truncate text-[13px] text-ink-3">
                          {pickup ? 'Pickup' : [o.shippingAddress?.line1, o.shippingAddress?.city, o.shippingAddress?.state].filter(Boolean).join(', ')}
                          {o.delivery?.zone ? ` · ${o.delivery.zone.name}` : ''}
                          {o.delivery?.carrierName ? ` · ${o.delivery.carrierName}` : o.delivery ? ` · ${DELIVERY_METHOD[o.delivery.method]}` : ''}
                          {o.delivery?.trackingReference ? ` · ${o.delivery.trackingReference}` : ''}
                        </p>
                        {o.delivery?.problemNote && st === 'FAILED' && <p className="text-[13px] text-warn">{o.delivery.problemNote}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="tabular text-ink-2">{formatMoney(o.totalMinor, o.currency)}</span>
                        <Badge tone={DELIVERY_STATUS[st].tone}>{pickup && st === 'DELIVERED' ? 'Collected' : DELIVERY_STATUS[st].label}</Badge>
                        <span className="text-[12px] text-ink-3">{when(o.delivery?.deliveredAt ?? o.delivery?.dispatchedAt ?? o.createdAt)}</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        {list.data && pages > 1 && (
          <div className="flex items-center justify-between border-t border-line px-5 py-3 text-sm">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <span className="text-ink-3">Page {page} of {pages}</span>
            <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        )}
      </Card>
    </>
  );
}
