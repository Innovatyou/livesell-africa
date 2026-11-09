'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { formatMoney } from '@/lib/money';
import { whatsappLink, whatsappOrderingText } from '@/lib/storefront';
import type { PublicProduct, PublicStore, WhatsappOrdering } from '@/lib/types';
import { useCart } from './cart';

export function ProductBuyBox({ store, product, ordering = null }: { store: PublicStore; product: PublicProduct; ordering?: WhatsappOrdering | null }) {
  const cart = useCart();
  const firstAvailable = product.variants.find((v) => v.availability !== 'out_of_stock') ?? product.variants[0];
  const [choice, setChoice] = useState<Record<string, string>>(firstAvailable.attributes);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  const [copied, setCopied] = useState(false);

  const variant = useMemo(
    () => product.variants.find((v) => Object.entries(v.attributes).every(([k, val]) => choice[k] === val)) ?? null,
    [product.variants, choice],
  );
  const soldOut = !variant || variant.availability === 'out_of_stock';
  const maxQty = variant?.onlyLeft ?? 99;

  const add = () => {
    if (!variant || soldOut) return;
    cart.add({
      variantId: variant.id, productSlug: product.slug, productCode: product.productCode, productName: product.name, variantName: variant.name,
      priceMinor: variant.priceMinor, quantity: Math.min(qty, maxQty), imageUrl: product.media.find((m) => m.type === 'image')?.url ?? null,
    });
    setAdded(true);
  };

  const share = async () => {
    const url = window.location.href;
    if (navigator.share) await navigator.share({ title: product.name, url }).catch(() => undefined);
    else await navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  return (
    <div className="space-y-4">
      <p className="tabular">
        <span className="text-2xl font-semibold">{formatMoney(variant?.priceMinor ?? firstAvailable.priceMinor, product.currency)}</span>
        {variant?.compareAtMinor && <span className="ml-2 text-ink-4 line-through">{formatMoney(variant.compareAtMinor, product.currency)}</span>}
      </p>

      {product.options.map((o) => (
        <fieldset key={o.name}>
          <legend className="mb-2 text-sm font-medium">{o.name}: <span className="font-normal text-ink-2">{choice[o.name]}</span></legend>
          <div className="flex flex-wrap gap-2">
            {o.values.map((val) => {
              const exists = product.variants.some((v) => v.attributes[o.name] === val && v.availability !== 'out_of_stock');
              return (
                <button key={val} type="button" aria-pressed={choice[o.name] === val} onClick={() => { setChoice({ ...choice, [o.name]: val }); setAdded(false); }}
                  className={`min-w-11 rounded-lg border px-3 py-2 text-sm ${choice[o.name] === val ? 'border-[var(--accent)] bg-surface font-medium ring-1 ring-[var(--accent)]' : 'border-line-strong bg-surface'} ${exists ? '' : 'text-ink-4 line-through'}`}>{val}</button>
              );
            })}
          </div>
        </fieldset>
      ))}

      <p role="status" className="text-sm">
        {!variant ? <span className="text-ink-3">This combination isn&apos;t available.</span>
          : variant.availability === 'out_of_stock' ? <span className="font-medium text-bad">Sold out</span>
          : variant.availability === 'low_stock' ? <span className="font-medium text-warn">Only {variant.onlyLeft} left</span>
          : <span className="text-good">In stock</span>}
      </p>

      <div className="flex gap-2">
        <div className="flex h-12 items-center rounded-[var(--radius-control)] border border-line-strong bg-surface">
          <button type="button" aria-label="Fewer" className="size-12 text-lg" disabled={qty <= 1} onClick={() => setQty(qty - 1)}>−</button>
          <span className="w-8 text-center tabular" aria-live="polite">{qty}</span>
          <button type="button" aria-label="More" className="size-12 text-lg" disabled={qty >= maxQty} onClick={() => setQty(qty + 1)}>+</button>
        </div>
        <button type="button" disabled={soldOut} onClick={add} className="h-12 flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] text-sm font-semibold text-white disabled:opacity-50">
          {soldOut ? 'Sold out' : 'Add to cart'}
        </button>
      </div>
      {added && (
        <p role="status" className="flex items-center justify-between rounded-lg bg-good-bg px-3 py-2 text-sm text-good">
          Added to your cart. <Link href={`/store/${store.slug}/cart`} className="font-semibold underline">View cart</Link>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {ordering?.enabled && ordering.number && !soldOut && (
          <a href={whatsappLink(ordering.number, whatsappOrderingText(store.slug, product.productCode))}
            target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center rounded-[var(--radius-control)] border border-brand-600 bg-surface px-4 text-sm font-medium text-brand-700">Order on WhatsApp</a>
        )}
        {store.whatsappNumber && variant && (
          <a href={whatsappLink(store.whatsappNumber, `Hello ${store.businessName}, I'd like ${product.productCode} ${product.name}${variant.name !== 'Default' ? ` (${variant.name})` : ''} × ${qty}.`)}
            target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 text-sm font-medium">Ask on WhatsApp</a>
        )}
        <button type="button" onClick={() => void share()} className="inline-flex h-10 items-center rounded-[var(--radius-control)] border border-line-strong bg-surface px-4 text-sm font-medium">{copied ? 'Link copied' : 'Share'}</button>
      </div>
    </div>
  );
}
