import type { Metadata } from 'next';
import { OrderTracking } from '@/components/store/order-tracking';

export const metadata: Metadata = { title: 'Your order', robots: { index: false, follow: false } };

export default async function OrderTrackingPage({ params }: { params: Promise<{ slug: string; reference: string }> }) {
  const { slug, reference } = await params;
  return <OrderTracking slug={slug} reference={reference} />;
}
