import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CheckoutForm } from '@/components/store/checkout-form';
import { fetchStore } from '@/lib/storefront';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };

export default async function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await fetchStore(slug);
  if (!store) notFound();
  return <CheckoutForm store={store} />;
}
