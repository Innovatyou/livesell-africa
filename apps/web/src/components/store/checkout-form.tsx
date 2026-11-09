'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { E164, normalisePhone } from '@/lib/nav';
import { cartTotal } from '@/lib/storefront';
import type { DeliveryOptions, PublicStore } from '@/lib/types';
import { useCart } from './cart';

const input = 'h-11 w-full rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 text-sm focus:border-[var(--accent)] focus:outline-none';

/** Storefront checkout: the server re-prices everything and reserves stock; payment details follow from the seller. */
export function CheckoutForm({ store }: { store: PublicStore }) {
  const cart = useCart();
  const router = useRouter();
  const [f, setF] = useState({ fullName: '', phone: '', email: '', line1: '', city: '', state: '', landmark: '', notes: '', website: '' });
  const [whatsappOptIn, setWhatsappOptIn] = useState(false);
  const [method, setMethod] = useState<'DELIVERY' | 'PICKUP'>('DELIVERY');
  const [quote, setQuote] = useState<DeliveryOptions | null>(null);
  const [pickup, setPickup] = useState<DeliveryOptions['pickup'] | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  const errors: Partial<Record<keyof typeof f, string>> = {};
  if (f.fullName.trim().length < 2) errors.fullName = 'Enter your name';
  if (!E164.test(normalisePhone(f.phone))) errors.phone = 'Enter a valid phone number, e.g. 0803 123 4567';
  if (f.email && !/^\S+@\S+\.\S+$/.test(f.email.trim())) errors.email = 'Enter a valid email or leave it empty';
  const delivering = method === 'DELIVERY';
  if (delivering && f.line1.trim().length < 3) errors.line1 = 'Enter your delivery address';
  if (delivering && f.city.trim().length < 2) errors.city = 'Enter your city';
  if (delivering && f.state.trim().length < 2) errors.state = 'Enter your state';
  const show = (k: keyof typeof f) => (submitted ? errors[k] : undefined);

  // Pickup availability once; the delivery fee for the typed area (shown only — the server prices the order again).
  useEffect(() => {
    let live = true;
    fetch(`${API_URL}/api/v1/store/${encodeURIComponent(store.slug)}/delivery-options`).then((r) => (r.ok ? r.json() : null)).then((d: DeliveryOptions | null) => { if (live && d) setPickup(d.pickup); }).catch(() => undefined);
    return () => { live = false; };
  }, [store.slug]);
  const city = f.city.trim();
  const state = f.state.trim();
  useEffect(() => {
    if (city.length < 2 || state.length < 2) { setQuote(null); return; }
    let live = true;
    const t = setTimeout(() => {
      fetch(`${API_URL}/api/v1/store/${encodeURIComponent(store.slug)}/delivery-options?state=${encodeURIComponent(state)}&city=${encodeURIComponent(city)}`)
        .then((r) => (r.ok ? r.json() : null)).then((d: DeliveryOptions | null) => { if (live) setQuote(d); }).catch(() => undefined);
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [store.slug, city, state]);
  const fee = delivering && quote?.delivery.available && quote.delivery.feeMinor ? BigInt(quote.delivery.feeMinor) : 0n;
  const outOfArea = delivering && quote !== null && !quote.delivery.available;

  if (cart.lines.length === 0) {
    return (
      <div className="mx-auto max-w-lg rounded-[var(--radius-card)] border border-line bg-surface px-6 py-12 text-center">
        <p className="font-medium">Your cart is empty</p>
        <Link href={`/store/${store.slug}`} className="mt-4 inline-flex h-11 items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-5 text-sm font-medium text-white">Continue shopping</Link>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setError(null);
    if (Object.keys(errors).length || outOfArea) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/store/${encodeURIComponent(store.slug)}/checkout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: { fullName: f.fullName.trim(), phone: normalisePhone(f.phone), ...(f.email.trim() ? { email: f.email.trim() } : {}) },
          items: cart.lines.map((l) => ({ variantId: l.variantId, quantity: Math.min(20, l.quantity) })),
          deliveryMethod: method,
          ...(delivering ? { shippingAddress: { line1: f.line1.trim(), city: f.city.trim(), state: f.state.trim(), ...(f.landmark.trim() ? { landmark: f.landmark.trim() } : {}) } } : {}),
          ...(f.notes.trim() ? { notes: f.notes.trim() } : {}), ...(f.website ? { website: f.website } : {}),
          ...(whatsappOptIn ? { whatsappOptIn: true } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const items = (body.items as Array<{ name: string; available: number }> | undefined)?.map((i) => `${i.name}: ${i.available} left`).join(', ');
        setError(res.status === 429 ? 'Too many attempts. Please wait a little and try again.' : `${Array.isArray(body.message) ? body.message.join('. ') : body.message ?? 'Your order could not be placed.'}${items ? ` (${items})` : ''}`);
        setBusy(false);
        return;
      }
      try { localStorage.setItem(`ls.order.${store.slug}.${body.reference}`, body.trackingToken); } catch { /* not essential */ }
      cart.clear();
      router.replace(`/store/${store.slug}/order/${body.reference}?token=${encodeURIComponent(body.trackingToken)}&new=1`);
    } catch {
      setError("Couldn't reach the store. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="mx-auto grid max-w-3xl gap-6 md:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Checkout</h1>
        {error && <p role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</p>}
        <fieldset className="space-y-3 rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <legend className="px-1 text-sm font-semibold">Your details</legend>
          {([['fullName', 'Full name', 'text', 'name'], ['phone', 'Phone (WhatsApp)', 'tel', 'tel'], ['email', 'Email (optional)', 'email', 'email']] as const).map(([k, l, t, ac]) => (
            <label key={k} className="block text-sm"><span className="mb-1 block font-medium text-ink-2">{l}</span>
              <input className={input} type={t} autoComplete={ac} value={f[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!show(k) || undefined} />
              {show(k) && <span className="mt-1 block text-[13px] text-bad">{show(k)}</span>}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-3 rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <legend className="px-1 text-sm font-semibold">{pickup?.available ? 'Delivery or pickup' : 'Delivery address'}</legend>
          {pickup?.available && (
            <div role="radiogroup" aria-label="Delivery or pickup" className="grid gap-2 sm:grid-cols-2">
              {([['DELIVERY', 'Deliver to me', 'Fee by area'], ['PICKUP', 'I’ll pick it up', 'Free']] as const).map(([k, l, h]) => (
                <label key={k} className={`flex cursor-pointer items-start gap-2 rounded-[var(--radius-control)] border p-3 text-sm ${method === k ? 'border-[var(--accent)]' : 'border-line-strong'}`}>
                  <input type="radio" name="method" className="mt-0.5 accent-[var(--accent)]" checked={method === k} onChange={() => setMethod(k)} />
                  <span><span className="block font-medium">{l}</span><span className="text-[12px] text-ink-3">{h}</span></span>
                </label>
              ))}
            </div>
          )}
          {!delivering && pickup?.address && <p className="rounded-lg bg-sunken px-3 py-2 text-sm text-ink-2">Pick up at <span className="font-medium">{pickup.address}</span>{pickup.instructions ? `. ${pickup.instructions}` : ''}</p>}
          {delivering && <>
          {([['line1', 'Street address', 'street-address'], ['city', 'City / area', 'address-level2'], ['state', 'State', 'address-level1'], ['landmark', 'Landmark (optional)', 'off']] as const).map(([k, l, ac]) => (
            <label key={k} className="block text-sm"><span className="mb-1 block font-medium text-ink-2">{l}</span>
              <input className={input} autoComplete={ac} value={f[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!show(k) || undefined} />
              {show(k) && <span className="mt-1 block text-[13px] text-bad">{show(k)}</span>}
            </label>
          ))}
          {outOfArea && <p role="alert" className="rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">{store.businessName} doesn’t deliver to {city}, {state} yet.{pickup?.available ? ' Choose pickup, or' : ''} Message the seller to arrange it.</p>}
          </>}
          <label className="block text-sm"><span className="mb-1 block font-medium text-ink-2">Note for the seller (optional)</span>
            <textarea className={`${input} h-20 py-2`} maxLength={500} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={whatsappOptIn} onChange={(e) => setWhatsappOptIn(e.target.checked)} />
            <span className="text-ink-2">Send me order updates on WhatsApp. You can reply STOP at any time. Without this, updates come by SMS{f.email.trim() ? ' and email' : ''}.</span>
          </label>
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden"><label htmlFor="website">Website</label><input id="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set('website', e.target.value)} /></div>
        </fieldset>
      </div>
      <aside className="space-y-3 md:pt-12">
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
          <ul className="space-y-2 text-sm">
            {cart.lines.map((l) => <li key={l.variantId} className="flex justify-between gap-2"><span className="min-w-0 truncate">{l.quantity} × {l.productName}{l.variantName !== 'Default' ? ` (${l.variantName})` : ''}</span><span className="tabular">{formatMoney(BigInt(l.priceMinor) * BigInt(l.quantity), store.currency)}</span></li>)}
          </ul>
          {!delivering ? <p className="mt-2 flex justify-between text-sm text-ink-2"><span>Pickup</span><span>Free</span></p>
            : fee > 0n ? <p className="mt-2 flex justify-between text-sm text-ink-2"><span>Delivery{quote?.delivery.zone ? ` (${quote.delivery.zone.name})` : ''}</span><span className="tabular">{formatMoney(fee, store.currency)}</span></p> : null}
          <div className="mt-3 flex justify-between border-t border-line pt-3 font-semibold"><span>Total</span><span className="tabular">{formatMoney(cartTotal(cart.lines) + fee, store.currency)}</span></div>
          {delivering && (quote === null ? <p className="mt-1 text-[12px] text-ink-3">Enter your city and state to see the delivery fee.</p>
            : quote.delivery.feeToBeAgreed ? <p className="mt-1 text-[12px] text-ink-3">The delivery fee for your area is confirmed by the seller.</p>
            : quote.delivery.zone?.etaDays != null ? <p className="mt-1 text-[12px] text-ink-3">Usually delivered within {quote.delivery.zone.etaDays} day{quote.delivery.zone.etaDays === 1 ? '' : 's'} of payment.</p> : null)}
        </div>
        <button type="submit" disabled={busy || outOfArea} className="h-12 w-full rounded-[var(--radius-control)] bg-[var(--accent)] text-sm font-semibold text-white disabled:opacity-60">{busy ? 'Placing order…' : 'Place order'}</button>
        <p className="text-center text-[12px] text-ink-3">Your items are held for you while you arrange payment with {store.businessName}.</p>
      </aside>
    </form>
  );
}
