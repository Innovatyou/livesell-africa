import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CartView } from '@/components/store/cart-view';
import { fetchStore } from '@/lib/storefront';

export const metadata: Metadata = { title: 'Your cart', robots: { index: false } };

export default async function CartPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await fetchStore(slug);
  if (!store) notFound();
  return <CartView store={store} />;
}
