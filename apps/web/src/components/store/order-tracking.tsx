'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { ORDER_STATUS } from '@/lib/order-labels';
import { whatsappLink } from '@/lib/storefront';
import { TransferPanel } from './transfer-panel';
import type { TrackedOrder } from '@/lib/types';

const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));
const STEPS = ['PENDING_PAYMENT', 'PAID', 'PROCESSING', 'DISPATCHED', 'DELIVERED'] as const;

function Tracking({ slug, reference }: { slug: string; reference: string }) {
  const params = useSearchParams();
  const isNew = params.get('new') === '1';
  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let token = params.get('token');
    if (!token) { try { token = localStorage.getItem(`ls.order.${slug}.${reference}`); } catch { token = null; } }
    if (!token) { setState('missing'); return; }
    setToken(token);
    fetch(`${API_URL}/api/v1/store/${encodeURIComponent(slug)}/orders/${encodeURIComponent(reference)}?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 404) return setState('missing');
        if (!r.ok) return setState('error');
        setOrder(await r.json());
        setState('ok');
      })
      .catch(() => setState('error'));
  }, [params, slug, reference, version]);

  if (state === 'loading') return <p className="py-12 text-center text-sm text-ink-3">Loading your order…</p>;
  if (state === 'missing') return <div className="mx-auto max-w-md rounded-[var(--radius-card)] border border-line bg-surface p-6 text-center"><p className="font-medium">We couldn&apos;t find that order</p><p className="mt-1 text-sm text-ink-3">Open the link you received when you placed the order, or message the seller with your order reference.</p></div>;
  if (state === 'error' || !order) return <p className="py-12 text-center text-sm text-bad">Couldn&apos;t load your order. Please refresh the page.</p>;

  const cancelled = order.status === 'CANCELLED';
  const reached = new Set(order.timeline.map((t) => t.status as string));
  const awaiting = ['PENDING_PAYMENT', 'PAYMENT_VERIFICATION'].includes(order.status);
  const message = `Hello ${order.store.businessName}, I placed order ${order.reference} (${formatMoney(order.totalMinor, order.currency)}). How do I pay?`;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {isNew && <p role="status" className="rounded-lg bg-good-bg px-4 py-3 text-sm text-good">Order placed. Save this page — it&apos;s your private link to follow the order.</p>}
      <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
        <p className="text-sm text-ink-3">Order</p>
        <h1 className="font-mono text-2xl font-semibold">{order.reference}</h1>
        <p className="mt-1 text-sm"><span className="font-medium">{ORDER_STATUS[order.status].label}</span> · placed {when(order.createdAt)}</p>
        {!cancelled && (
          <ol className="mt-4 grid grid-cols-5 gap-1 text-center text-[11px]">
            {STEPS.map((s) => <li key={s} className="space-y-1"><span className={`mx-auto block h-1.5 rounded-full ${reached.has(s) ? 'bg-[var(--accent)]' : 'bg-line'}`} /><span className={reached.has(s) ? 'text-ink' : 'text-ink-4'}>{ORDER_STATUS[s].label}</span></li>)}
          </ol>
        )}
        {awaiting && (
          <div className="mt-4 rounded-lg bg-sunken p-3 text-sm text-ink-2">
            <p className="font-medium text-ink">Next: pay {order.store.businessName}</p>
            <p>{order.store.orderInstructions ?? 'The seller will send you payment details.'}{order.holdExpiresAt ? ` Your items are held until ${when(order.holdExpiresAt)}.` : ''}</p>
            {token && <TransferPanel order={order} token={token} total={formatMoney(order.totalMinor, order.currency)} onReported={() => setVersion((v) => v + 1)} />}
            {order.status === 'PENDING_PAYMENT' && order.onlinePayment?.online && token && <PayNow slug={slug} reference={order.reference} token={token} total={formatMoney(order.totalMinor, order.currency)} testMode={!!order.onlinePayment.testMode} providerName={order.onlinePayment.providerName ?? 'our payment partner'} />}
            {order.store.whatsappNumber && <a href={whatsappLink(order.store.whatsappNumber, message)} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex h-11 items-center rounded-[var(--radius-control)] bg-[#1f8b4c] px-4 text-sm font-semibold text-white">Message the seller on WhatsApp</a>}
          </div>
        )}
        {cancelled && <p className="mt-3 rounded-lg bg-sunken p-3 text-sm text-ink-2">This order was cancelled. Message the seller if you still want these items.</p>}
      </div>
      <div className="rounded-[var(--radius-card)] border border-line bg-surface p-5">
        <ul className="space-y-2 text-sm">
          {order.items.map((i, n) => <li key={n} className="flex justify-between gap-3"><span>{i.quantity} × {i.productCode ? `${i.productCode} ` : ''}{i.productName}{i.variantName !== 'Default' ? ` (${i.variantName})` : ''}</span><span className="tabular">{formatMoney(i.lineTotalMinor, order.currency)}</span></li>)}
        </ul>
        <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
          {order.discountMinor !== '0' && <div className="flex justify-between"><dt>Discount</dt><dd className="tabular">− {formatMoney(order.discountMinor, order.currency)}</dd></div>}
          {order.deliveryFeeMinor !== '0' && <div className="flex justify-between"><dt>Delivery</dt><dd className="tabular">{formatMoney(order.deliveryFeeMinor, order.currency)}</dd></div>}
          <div className="flex justify-between font-semibold"><dt>Total</dt><dd className="tabular">{formatMoney(order.totalMinor, order.currency)}</dd></div>
        </dl>
        {order.shippingAddress && <p className="mt-3 text-[13px] text-ink-3">Delivering to {[order.shippingAddress.line1, order.shippingAddress.city, order.shippingAddress.state].filter(Boolean).join(', ')}</p>}
        {order.delivery && <DeliveryInfo d={order.delivery} />}
      </div>
      <ol className="space-y-1 px-1 text-[13px] text-ink-3">{order.timeline.map((t, i) => <li key={i}>{when(t.at)} — {ORDER_STATUS[t.status].label}</li>)}</ol>
    </div>
  );
}

/** Online payment: the server creates the provider's checkout link; the order is marked paid only after server-side verification. */
function PayNow({ slug, reference, token, total, testMode, providerName }: { slug: string; reference: string; token: string; total: string; testMode: boolean; providerName: string }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_URL}/api/v1/store/${encodeURIComponent(slug)}/orders/${encodeURIComponent(reference)}/pay`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, email: email.trim() }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof body.message === 'string' ? body.message : 'Payment could not be started. Please try again.');
      window.location.assign(body.checkoutUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment could not be started. Please try again.');
      setBusy(false);
    }
  }
  return (
    <form onSubmit={go} className="mt-3 space-y-2 rounded-lg border border-line bg-surface p-3">
      <p className="font-medium text-ink">Pay {total} online</p>
      <label className="block text-[13px] text-ink-3" htmlFor="pay-email">Email for your receipt</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input id="pay-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
          className="h-11 flex-1 rounded-[var(--radius-control)] border border-line bg-surface px-3 text-sm text-ink" />
        <button type="submit" disabled={!valid || busy} className="h-11 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? `Opening ${providerName}…` : 'Pay now'}</button>
      </div>
      {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
      <p className="text-[12px] text-ink-4">Card, bank transfer or USSD via {providerName}.{testMode ? ' Test mode: no real money is taken.' : ''}</p>
    </form>
  );
}

export function OrderTracking(props: { slug: string; reference: string }) {
  return <Suspense fallback={<p className="py-12 text-center text-sm text-ink-3">Loading…</p>}><Tracking {...props} /></Suspense>;
}

const DELIVERY_WORDS: Record<string, string> = { PENDING: 'Being prepared', ASSIGNED: 'Rider assigned', IN_TRANSIT: 'On the way', DELIVERED: 'Delivered', FAILED: 'Delivery attempt failed — the seller will contact you', RETURNED: 'Returned to the seller' };

function DeliveryInfo({ d }: { d: NonNullable<TrackedOrder['delivery']> }) {
  const pickup = d.method === 'PICKUP';
  return (
    <div className="mt-3 rounded-lg bg-sunken px-3 py-2 text-[13px] text-ink-2">
      <p className="font-medium text-ink">{pickup ? (d.status === 'DELIVERED' ? 'Collected' : 'Pickup') : DELIVERY_WORDS[d.status]}</p>
      {pickup && d.pickupAddress && d.status !== 'DELIVERED' && <p>Pick up at {d.pickupAddress}{d.pickupInstructions ? `. ${d.pickupInstructions}` : ''}</p>}
      {!pickup && d.carrierName && <p>With {d.carrierName}{d.trackingReference ? ` · tracking ${d.trackingReference}` : ''}</p>}
      {!pickup && d.carrierPhone && <p>Rider / courier: <a className="font-medium underline" href={`tel:${d.carrierPhone}`}>{d.carrierPhone}</a></p>}
      {!pickup && !d.carrierName && d.trackingReference && <p>Tracking {d.trackingReference}</p>}
      {!pickup && d.zone?.etaDays != null && d.status === 'PENDING' && <p>Usually delivered within {d.zone.etaDays} day{d.zone.etaDays === 1 ? '' : 's'} of payment.</p>}
    </div>
  );
}
