'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { OrderForm } from '@/components/order-form';
import { PageHeader } from '@/components/page-header';
import { Alert, ErrorState, PageLoading } from '@/components/ui';
import type { Order } from '@/lib/types';
import { useApi } from '@/lib/use-api';

export default function EditOrderPage() {
  const { id } = useParams<{ id: string }>();
  const order = useApi<Order>(`/orders/${id}`);
  if (order.error) return <ErrorState message={order.error} onRetry={order.reload} />;
  if (!order.data) return <PageLoading />;
  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 text-sm"><Link href={`/orders/${id}`} className="text-ink-3 hover:text-ink">← {order.data.reference}</Link></p>
      <PageHeader title={`Edit ${order.data.reference}`} />
      {order.data.editable ? <OrderForm order={order.data} /> : <Alert tone="info">This order can no longer be edited.</Alert>}
    </div>
  );
}
