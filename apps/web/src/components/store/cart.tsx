'use client';

import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { CartLine } from '@/lib/storefront';

interface CartState {
  lines: CartLine[];
  count: number;
  add: (line: CartLine) => void;
  setQuantity: (variantId: string, quantity: number) => void;
  remove: (variantId: string) => void;
  clear: () => void;
}

const Ctx = createContext<CartState | null>(null);
const MAX_QTY = 99;

/** Per-store cart kept in the browser (localStorage). Nothing is reserved until an order is placed. */
export function CartProvider({ slug, children }: { slug: string; children: React.ReactNode }) {
  const key = `ls.cart.${slug}`;
  const [lines, setLines] = useState<CartLine[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setLines((JSON.parse(raw) as CartLine[]).filter((l) => l && /^\d+$/.test(l.priceMinor) && l.quantity > 0));
    } catch {
      /* storage unavailable or corrupt: start empty */
    }
  }, [key]);

  const persist = useCallback((next: CartLine[]) => {
    setLines(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private mode: the cart lasts for this page only */
    }
  }, [key]);

  const value = useMemo<CartState>(() => ({
    lines,
    count: lines.reduce((n, l) => n + l.quantity, 0),
    add: (line) => {
      const existing = lines.find((l) => l.variantId === line.variantId);
      persist(existing
        ? lines.map((l) => (l.variantId === line.variantId ? { ...line, quantity: Math.min(MAX_QTY, l.quantity + line.quantity) } : l))
        : [...lines, { ...line, quantity: Math.min(MAX_QTY, line.quantity) }]);
    },
    setQuantity: (variantId, quantity) => persist(lines.map((l) => (l.variantId === variantId ? { ...l, quantity: Math.max(1, Math.min(MAX_QTY, quantity)) } : l))),
    remove: (variantId) => persist(lines.filter((l) => l.variantId !== variantId)),
    clear: () => persist([]),
  }), [lines, persist]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCart() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCart must be used inside <CartProvider>');
  return c;
}

export function CartButton({ slug }: { slug: string }) {
  const { count } = useCart();
  return (
    <Link href={`/store/${slug}/cart`} className="relative inline-flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-medium" aria-label={`Cart, ${count} item${count === 1 ? '' : 's'}`}>
      <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M6 6h15l-1.5 9h-12zM6 6 5 3H2M9 20h.01M18 20h.01" /></svg>
      Cart
      {count > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-[var(--accent)] px-1.5 text-[11px] text-white">{count}</span>}
    </Link>
  );
}
