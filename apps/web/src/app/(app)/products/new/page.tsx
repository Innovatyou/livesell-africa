'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { ProductForm } from '@/components/product-form';
import { Card, EmptyState } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function NewProductPage() {
  const { can } = useAuth();
  if (!can('products:write')) return <Card><EmptyState title="Your role can't add products" /></Card>;
  return (
    <div className="mx-auto max-w-4xl">
      <p className="mb-2 text-sm"><Link href="/products" className="text-ink-3 hover:text-ink">← Products</Link></p>
      <PageHeader title="New product" />
      <ProductForm />
    </div>
  );
}
