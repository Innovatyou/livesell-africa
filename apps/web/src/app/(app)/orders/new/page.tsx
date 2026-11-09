'use client';

import Link from 'next/link';
import { OrderForm } from '@/components/order-form';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function NewOrderPage() {
  const { can } = useAuth();
  if (!can('orders:create')) return <Card><EmptyState title="Your role can't create orders" /></Card>;
  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 text-sm"><Link href="/orders" className="text-ink-3 hover:text-ink">← Orders</Link></p>
      <PageHeader title="New order" description="Confirmed orders reserve stock and wait for payment." />
      <OrderForm />
    </div>
  );
}
