'use client';

import Link from 'next/link';
import { formatMoney } from '@/lib/money';
import { cartTotal, whatsappLink, whatsappOrderText } from '@/lib/storefront';
import type { PublicStore } from '@/lib/types';
import { useCart } from './cart';

export function CartView({ store }: { store: PublicStore }) {
  const cart = useCart();
  const total = cartTotal(cart.lines);
  const contact = store.whatsappNumber ?? store.contactPhone;

  if (cart.lines.length === 0) {
    return (
      <div className="mx-auto max-w-lg rounded-[var(--radius-card)] border border-line bg-surface px-6 py-12 text-center">
        <p className="font-medium">Your cart is empty</p>
        <p className="mt-1 text-sm text-ink-3">Browse the store and add what you like.</p>
        <Link href={`/store/${store.slug}`} className="mt-4 inline-flex h-11 items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-5 text-sm font-medium text-white">Continue shopping</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Your cart</h1>
      <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
        {cart.lines.map((l) => (
          <li key={l.variantId} className="flex gap-3 p-3">
            <Link href={`/store/${store.slug}/p/${l.productSlug}`} className="size-16 shrink-0 overflow-hidden rounded-lg bg-sunken">
              {l.imageUrl && <img src={l.imageUrl} alt="" className="size-full object-cover" />}
            </Link>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold text-ink-3">{l.productCode}</p>
              <p className="truncate text-sm font-medium">{l.productName}</p>
              {l.variantName !== 'Default' && <p className="text-[13px] text-ink-3">{l.variantName}</p>}
              <div className="mt-2 flex items-center gap-3">
                <label className="sr-only" htmlFor={`q-${l.variantId}`}>Quantity</label>
                <select id={`q-${l.variantId}`} value={l.quantity} onChange={(e) => cart.setQuantity(l.variantId, Number(e.target.value))} className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm">
                  {Array.from({ length: Math.max(10, l.quantity) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button type="button" onClick={() => cart.remove(l.variantId)} className="text-sm text-ink-3 hover:text-bad">Remove</button>
              </div>
            </div>
            <p className="text-sm font-semibold tabular">{formatMoney(BigInt(l.priceMinor) * BigInt(l.quantity), store.currency)}</p>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-line bg-surface p-4">
        <span className="text-ink-2">Total</span>
        <span className="text-xl font-semibold tabular">{formatMoney(total, store.currency)}</span>
      </div>

      <Link href={`/store/${store.slug}/checkout`} className="flex h-12 items-center justify-center rounded-[var(--radius-control)] bg-[var(--accent)] text-sm font-semibold text-white">Checkout</Link>
      {store.whatsappNumber ? (
        <a href={whatsappLink(store.whatsappNumber, whatsappOrderText(store, cart.lines))} target="_blank" rel="noopener noreferrer"
          className="flex h-12 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-line-strong bg-surface text-sm font-semibold text-ink">
          Or send the order on WhatsApp
        </a>
      ) : contact ? (
        <a href={`tel:${contact}`} className="flex h-12 items-center justify-center rounded-[var(--radius-control)] bg-[var(--accent)] text-sm font-semibold text-white">Call {store.businessName} to order</a>
      ) : null}
      <p className="text-center text-[13px] text-ink-3">
        Checkout holds your items and gives you a link to follow the order. The seller confirms delivery and payment details with you.
      </p>
      <div className="flex justify-between text-sm">
        <Link href={`/store/${store.slug}`} className="font-medium text-ink hover:underline">← Continue shopping</Link>
        <button type="button" onClick={cart.clear} className="text-ink-3 hover:text-bad">Empty cart</button>
      </div>
    </div>
  );
}
