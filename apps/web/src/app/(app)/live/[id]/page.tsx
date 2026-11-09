'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/dialog';
import { LiveSessionForm } from '@/components/live-session-form';
import { OrderForm } from '@/components/order-form';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBps, formatMoney } from '@/lib/money';
import { LIVE_BADGE, ORDER_STATUS } from '@/lib/order-labels';
import type { LiveReport, LiveSession, OrderListItem, Page } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const when = (s: string) => new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));

export default function LiveSessionPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const session = useApi<LiveSession>(`/live-sessions/${id}`);
  const report = useApi<LiveReport>(`/live-sessions/${id}/report`);
  const orders = useApi<Page<OrderListItem>>(can('orders:read') ? `/orders?liveSessionId=${id}&pageSize=20` : null);
  const [editing, setEditing] = useState(false);
  const [ending, setEnding] = useState(false);
  const [viewers, setViewers] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const prices = useMemo(() => new Map((session.data?.products ?? []).map((p) => [p.productId, p.sessionPriceMinor])), [session.data]);

  const isLive = session.data?.status === 'LIVE';
  const { reload: reloadOrders } = orders;
  const { reload: reloadReport } = report;
  const { reload: reloadSession } = session;
  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => { void reloadOrders(); void reloadReport(); void reloadSession(); }, 15_000);
    return () => clearInterval(t);
  }, [isLive, reloadOrders, reloadReport, reloadSession]);

  if (session.error) return <ErrorState message={session.error} onRetry={session.reload} />;
  if (!session.data) return <PageLoading />;
  const s = session.data;
  const manage = can('live:manage');

  async function act(key: string, path: string, body: object, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      session.setData(await api<LiveSession>(`/live-sessions/${id}/${path}`, { method: 'POST', body }));
      setMsg({ tone: 'good', text: ok });
      void report.reload();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  const r = report.data;
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-sm"><Link href="/live" className="text-ink-3 hover:text-ink">← Live selling</Link></p>
        <PageHeader title={s.title}
          description={<span className="flex flex-wrap items-center gap-2"><Badge tone={LIVE_BADGE[s.status][0]}>{LIVE_BADGE[s.status][1]}</Badge>{s.channel.name}{s.channel.handle ? ` ${s.channel.handle}` : ''} · {when(s.scheduledAt)}</span>}
          action={manage && <div className="flex flex-wrap gap-2">
            {['SCHEDULED', 'LIVE'].includes(s.status) && <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
            {s.status === 'SCHEDULED' && <Button size="sm" variant="ghost" loading={busy === 'cancel'} onClick={() => { if (window.confirm('Cancel this session?')) void act('cancel', 'cancel', {}, 'Session cancelled.'); }}>Cancel</Button>}
            {s.status === 'SCHEDULED' && <Button size="sm" loading={busy === 'start'} onClick={() => void act('start', 'start', {}, 'You are live. Record orders below.')}>Go live</Button>}
            {s.status === 'LIVE' && <Button size="sm" variant="danger" onClick={() => setEnding(true)}>End live</Button>}
          </div>} />
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {s.orderInstructions && <p className="rounded-lg bg-sunken px-4 py-2 text-sm text-ink-2"><span className="font-medium">How viewers order: </span>{s.orderInstructions}</p>}

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {can('orders:create') && ['LIVE', 'ENDED'].includes(s.status) ? (
            <div>
              <h2 className="mb-2 text-[15px] font-semibold">Record an order</h2>
              <OrderForm liveSessionId={s.id} sessionPrices={prices} compact onCreated={(o) => { setMsg({ tone: 'good', text: `Order ${o.reference} recorded — ${formatMoney(o.totalMinor, o.currency)}. Stock reserved.` }); void orders.reload(); void report.reload(); void session.reload(); }} />
            </div>
          ) : s.status === 'SCHEDULED' && <Alert tone="info">Orders can be recorded once you go live.</Alert>}

          <Card>
            <CardHeader title="Orders from this live" action={orders.data && orders.data.total > 0 && <ButtonLink href={`/orders?liveSessionId=${s.id}`} size="sm" variant="ghost">All {orders.data.total}</ButtonLink>} />
            {!orders.data ? <p className="p-5 text-sm text-ink-3">{orders.error ?? 'Loading…'}</p> : orders.data.items.length === 0 ? <EmptyState title="No orders yet" /> : (
              <ul className="divide-y divide-line">
                {orders.data.items.map((o) => (
                  <li key={o.id} className="flex items-center justify-between px-5 py-3 text-sm">
                    <span><Link href={`/orders/${o.id}`} className="font-mono font-medium hover:text-brand-700">{o.reference}</Link> <span className="text-ink-3">{o.customer?.fullName ?? ''}</span></span>
                    <span className="flex items-center gap-3"><Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge><span className="tabular">{formatMoney(o.totalMinor, o.currency)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title={s.status === 'ENDED' ? 'Sales report' : 'So far'} description="From real orders. Paid = payment verified." />
            {!r ? <p className="p-5 text-sm text-ink-3">{report.error ?? 'Loading…'}</p> : (
              <div className="space-y-4 p-5">
                <div className="grid grid-cols-2 gap-3">
                  {[['Revenue (paid)', formatMoney(r.revenueMinor)], ['Awaiting payment', formatMoney(r.awaitingPaymentMinor)], ['Orders', `${r.orders.total}`], ['Paid orders', `${r.orders.paid}`],
                    ['Units sold', `${r.unitsSold}`], ['Avg order', formatMoney(r.averageOrderValueMinor)], ['Payment completion', r.paymentCompletionBps === null ? '—' : formatBps(r.paymentCompletionBps)], ['Cancelled', r.cancellationBps === null ? '—' : formatBps(r.cancellationBps)]].map(([l, v]) => (
                    <div key={l}><p className="text-[12px] text-ink-3">{l}</p><p className="font-semibold tabular">{v}</p></div>
                  ))}
                </div>
                <p className="text-[12px] text-ink-3">
                  {r.durationMinutes !== null && `${r.durationMinutes} min live · `}{r.uniqueCustomers} customer{r.uniqueCustomers === 1 ? '' : 's'} · {r.viewerData === 'seller_reported' ? `${r.session.peakViewers} peak viewers (as you reported)` : 'viewer numbers not provided'}
                </p>
                {r.topProducts.length > 0 && (
                  <div>
                    <p className="mb-1 text-[13px] font-medium">Top products</p>
                    <ul className="space-y-1 text-sm">{r.topProducts.map((p) => <li key={p.productCode ?? p.name} className="flex justify-between"><span><span className="font-mono text-[12px] text-ink-3">{p.productCode}</span> {p.name}</span><span className="tabular">{p.quantity} · {formatMoney(p.revenueMinor)}</span></li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Products in this live" />
            {s.products.length === 0 ? <EmptyState title="No products picked">Edit the session to add products — or record any product by its code.</EmptyState> : (
              <ul className="divide-y divide-line">
                {s.products.map((p) => (
                  <li key={p.productId} className="px-5 py-3 text-sm">
                    <p><span className="font-mono font-semibold">{p.product.productCode}</span> {p.product.name}</p>
                    <p className="text-[12px] text-ink-3">
                      {p.sessionPriceMinor ? <><span className="font-medium text-brand-700">Live price {formatMoney(p.sessionPriceMinor)}</span> · </> : null}
                      {p.product.variants.map((v) => `${v.name === 'Default' ? '' : `${v.name}: `}${v.available} left`).join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {editing && (
        <Dialog open wide onClose={() => setEditing(false)} title="Edit session">
          <LiveSessionForm session={s} onSaved={(ns) => { session.setData(ns); setEditing(false); setMsg({ tone: 'good', text: 'Session saved.' }); }} />
        </Dialog>
      )}
      {ending && (
        <Dialog open onClose={() => setEnding(false)} title="End live session" description="Orders recorded later can still be linked to this session."
          footer={<><Button variant="ghost" onClick={() => setEnding(false)}>Back</Button><Button variant="danger" loading={busy === 'end'} disabled={!!viewers && !/^\d{1,9}$/.test(viewers)} onClick={() => void act('end', 'end', viewers ? { peakViewers: Number(viewers) } : {}, 'Live ended. Your report is ready.').then(() => setEnding(false))}>End live</Button></>}>
          <Field label="Peak viewers (optional)" hint="Copy the number the platform showed you. Leave empty if you don't know — we never estimate it.">
            {(p) => <Input {...p} inputMode="numeric" value={viewers} onChange={(e) => setViewers(e.target.value.replace(/\D/g, ''))} />}
          </Field>
        </Dialog>
      )}
    </div>
  );
}
