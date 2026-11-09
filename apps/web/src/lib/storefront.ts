import { formatMoney } from './money';
import type { PublicProduct, PublicProductCard, PublicStore, WhatsappOrdering } from './types';

const API = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const REVALIDATE = 60;

/** Server-side fetch for public store pages. Returns null on 404 (store hidden or missing) so pages can notFound(). */
async function get<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API}/api/v1/store/${path}`, { next: { revalidate: REVALIDATE } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Store request failed (${res.status})`);
  return (await res.json()) as T;
}

export const fetchStore = (slug: string) => get<PublicStore>(encodeURIComponent(slug));
export const fetchProducts = (slug: string, qs: string) => get<{ items: PublicProductCard[]; total: number; page: number; pageSize: number }>(`${encodeURIComponent(slug)}/products?${qs}`);
/** Whether customers can order on the platform WhatsApp number; never breaks the page if the API can't say. */
export const fetchWhatsappOrdering = (slug: string) => get<WhatsappOrdering>(`${encodeURIComponent(slug)}/whatsapp-ordering`).catch(() => null);
export const fetchProduct = (slug: string, productSlug: string) => get<PublicProduct>(`${encodeURIComponent(slug)}/products/${encodeURIComponent(productSlug)}`);

export interface CartLine {
  variantId: string; productSlug: string; productCode: string; productName: string; variantName: string; priceMinor: string; quantity: number; imageUrl: string | null;
}

export function cartTotal(lines: CartLine[]): bigint {
  return lines.reduce((s, l) => s + BigInt(l.priceMinor) * BigInt(l.quantity), 0n);
}

/** The order message a customer sends on WhatsApp: product codes first, because that's how sellers take live orders. */
export function whatsappOrderText(store: Pick<PublicStore, 'businessName' | 'currency'>, lines: CartLine[]): string {
  const items = lines.map((l) => `• ${l.productCode} ${l.productName}${l.variantName !== 'Default' ? ` (${l.variantName})` : ''} × ${l.quantity} — ${formatMoney(BigInt(l.priceMinor) * BigInt(l.quantity), store.currency)}`);
  return [
    `Hello ${store.businessName}, I'd like to order:`, ...items, `Total: ${formatMoney(cartTotal(lines), store.currency)}`, '',
    'My name:', 'Delivery address:',
  ].join('\n');
}

/** First message for ordering on the platform number: the store name and the product code (the bot takes it from there). */
export function whatsappOrderingText(storeSlug: string, productCode: string): string {
  return `${storeSlug} ${productCode}`;
}

export function whatsappLink(number: string, text: string): string {
  return `https://wa.me/${number.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}
