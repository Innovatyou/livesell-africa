'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Dialog } from '@/components/dialog';
import { OrderDeliveryCard } from '@/components/order-delivery';
import { OrderMessages } from '@/components/order-messages';
import { OrderPayments } from '@/components/order-payments';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, ErrorState, Field, PageLoading, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money';
import { ACTION_LABEL, ORDER_STATUS, relativeHold } from '@/lib/order-labels';
import type { Order, OrderStatus } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(s));
const PERM: Partial<Record<OrderStatus, string>> = { PENDING_PAYMENT: 'orders:create', CANCELLED: 'orders:cancel', PROCESSING: 'orders:update_status', READY_FOR_DISPATCH: 'orders:update_status', DISPATCHED: 'orders:update_status', DELIVERED: 'orders:update_status' };

function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const saved = useSearchParams().get('saved') === '1';
  const { can } = useAuth();
  const order = useApi<Order>(`/orders/${id}`);
  const [target, setTarget] = useState<OrderStatus | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(saved ? { tone: 'good', text: 'Order saved.' } : null);

  if (order.error) return <ErrorState message={order.error} onRetry={order.reload} />;
  if (!order.data) return <PageLoading />;
  const o = order.data;
  const actions = o.nextStatuses.filter((s) => can(PERM[s] ?? ''));

  async function run(key: string, fn: () => Promise<Order>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      order.setData(await fn());
      setMsg({ tone: 'good', text: ok });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }
  const doMove = (to: OrderStatus) => run('move', () => api<Order>(`/orders/${o.id}/status`, { method: 'POST', body: { status: to, ...(note.trim() ? { note: note.trim() } : {}) } }), `Order ${ORDER_STATUS[to].label.toLowerCase()}.`).then(() => { setTarget(null); setNote(''); });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="mb-2 text-sm"><Link href="/orders" className="text-ink-3 hover:text-ink">← Orders</Link></p>
        <PageHeader title={o.reference}
          description={<span className="flex flex-wrap items-center gap-2"><Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge><span>{when(o.createdAt)}</span>{o.reservationExpiresAt && <span className="text-warn">{relativeHold(o.reservationExpiresAt)}</span>}</span>}
          action={<div className="flex flex-wrap gap-2">
            <ButtonLink href={`/orders/${o.id}/print`} size="sm" variant="secondary">{o.paymentStatus === 'PAID' ? 'Print receipt' : 'Print invoice'}</ButtonLink>
            {o.editable && can('orders:create') && <ButtonLink href={`/orders/${o.id}/edit`} size="sm" variant="secondary">Edit</ButtonLink>}
            {o.canExtendHold && can('orders:create') && <Button size="sm" variant="secondary" loading={busy === 'hold'} onClick={() => void run('hold', () => api<Order>(`/orders/${o.id}/extend-hold`, { method: 'POST', body: { hours: 24 } }), 'Stock held 24 hours longer.')}>Hold 24h longer</Button>}
            {actions.map((s) => <Button key={s} size="sm" variant={s === 'CANCELLED' ? 'danger' : 'primary'} onClick={() => setTarget(s)}>{ACTION_LABEL[s] ?? s}</Button>)}
          </div>} />
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <Card>
        <CardHeader title="Items" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <tbody className="divide-y divide-line">
              {o.items.map((i) => (
                <tr key={i.id}>
                  <td className="px-5 py-3"><span className="font-mono text-[12px] text-ink-3">{i.productCode ?? i.sku}</span> {i.productName}{i.variantName !== 'Default' && <span className="text-ink-3"> · {i.variantName}</span>}{!!i.backorderedQty && <span className="ml-2 inline-block rounded-full bg-info-bg px-2 py-0.5 text-[11px] font-semibold text-info">Pre-order: {i.backorderedQty} awaiting stock</span>}</td>
                  <td className="px-5 py-3 text-right tabular text-ink-2">{formatMoney(i.unitPriceMinor, o.currency)} × {i.quantity}{i.discountMinor !== '0' && <span className="text-ink-3"> − {formatMoney(i.discountMinor, o.currency)}</span>}</td>
                  <td className="px-5 py-3 text-right tabular">{formatMoney(i.lineTotalMinor, o.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="space-y-1 border-t border-line px-5 py-4 text-sm">
          <div className="flex justify-between"><dt className="text-ink-3">Subtotal</dt><dd className="tabular">{formatMoney(o.subtotalMinor, o.currency)}</dd></div>
          {o.discountMinor !== '0' && <div className="flex justify-between"><dt className="text-ink-3">Discount</dt><dd className="tabular">− {formatMoney(o.discountMinor, o.currency)}</dd></div>}
          <div className="flex justify-between"><dt className="text-ink-3">Delivery</dt><dd className="tabular">{formatMoney(o.deliveryFeeMinor, o.currency)}</dd></div>
          <div className="flex justify-between pt-1 text-base font-semibold"><dt>Total</dt><dd className="tabular">{formatMoney(o.totalMinor, o.currency)}</dd></div>
        </dl>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader title="Customer" />
          <div className="space-y-1 p-5 text-sm">
            {o.customer ? <>
              <Link href={`/customers/${o.customer.id}`} className="font-medium hover:text-brand-700">{o.customer.fullName}</Link>
              {o.customer.phone && <p className="text-ink-2">{o.customer.phone}</p>}
              {o.customer.email && <p className="text-ink-2">{o.customer.email}</p>}
            </> : <p className="text-ink-3">No customer on this order.</p>}
            {o.shippingAddress && <p className="pt-2 text-ink-2">{[o.shippingAddress.line1, o.shippingAddress.line2, o.shippingAddress.city, o.shippingAddress.state].filter(Boolean).join(', ')}{o.shippingAddress.landmark ? ` · ${o.shippingAddress.landmark}` : ''}</p>}
            {o.notes && <p className="pt-2 text-ink-3">Note: {o.notes}</p>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Source and payment" />
          <dl className="space-y-1 p-5 text-sm">
            <div className="flex justify-between"><dt className="text-ink-3">Channel</dt><dd>{o.channel?.name ?? '—'}</dd></div>
            {o.liveSession && <div className="flex justify-between"><dt className="text-ink-3">Live session</dt><dd><Link href={`/live/${o.liveSession.id}`} className="hover:text-brand-700">{o.liveSession.title}</Link></dd></div>}
            <div className="flex justify-between"><dt className="text-ink-3">Payment</dt><dd>{o.paymentStatus.replace(/_/g, ' ').toLowerCase()}</dd></div>
          </dl>
        </Card>
      </div>

      <OrderPayments order={o} onChanged={order.reload} />

      <OrderDeliveryCard key={`d:${o.id}:${o.status}`} orderId={o.id} onChanged={order.reload} />

      {o.customer && <OrderMessages key={`${o.id}:${o.status}`} orderId={o.id} status={o.status} />}

      <Card>
        <CardHeader title="Activity" />
        <ol className="space-y-3 p-5">
          {o.statusHistory.map((h) => (
            <li key={h.id} className="flex gap-3 text-sm">
              <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-500" />
              <div>
                <p><span className="font-medium">{h.fromStatus === h.toStatus ? 'Updated' : ORDER_STATUS[h.toStatus].label}</span>{h.note && <span className="text-ink-2"> — {h.note}</span>}</p>
                <p className="text-[12px] text-ink-3">{when(h.createdAt)} · {h.actorName ?? (h.actorType === 'system' ? 'LiveSell' : h.actorType === 'customer' ? 'Customer' : 'Team')}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      {target && (
        <Dialog open onClose={() => setTarget(null)} title={ACTION_LABEL[target] ?? 'Update order'} description={target === 'CANCELLED' ? 'Reserved stock goes back on sale.' : target === 'DISPATCHED' || target === 'DELIVERED' ? 'Reserved stock is recorded as sold.' : undefined}
          footer={<><Button variant="ghost" onClick={() => setTarget(null)}>Back</Button><Button variant={target === 'CANCELLED' ? 'danger' : 'primary'} loading={busy === 'move'} onClick={() => void doMove(target)}>{ACTION_LABEL[target]}</Button></>}>
          <Field label="Note (optional)" hint={target === 'DISPATCHED' ? 'e.g. courier and waybill number' : 'Saved in the order activity'}>{(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </Dialog>
      )}
    </div>
  );
}

export default function OrderPage() {
  return <Suspense fallback={<PageLoading />}><OrderDetail /></Suspense>;
}
