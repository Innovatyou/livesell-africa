'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { ProductForm } from '@/components/product-form';
import { Alert, Badge, ErrorState, PageLoading } from '@/components/ui';
import type { Product } from '@/lib/types';
import { useApi } from '@/lib/use-api';

function EditProduct() {
  const { id } = useParams<{ id: string }>();
  const created = useSearchParams().get('created') === '1';
  const product = useApi<Product>(`/products/${id}`);
  const [notice, setNotice] = useState<string | null>(null);
  if (product.error) return <ErrorState message={product.error} onRetry={product.reload} />;
  if (!product.data) return <PageLoading />;
  const p = product.data;
  return (
    <div className="mx-auto max-w-4xl">
      <p className="mb-2 text-sm"><Link href="/products" className="text-ink-3 hover:text-ink">← Products</Link></p>
      <PageHeader
        title={p.name}
        description={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{p.productCode}</span>
          {p.stock.outOfStock ? <Badge tone="bad">Out of stock</Badge> : p.stock.lowStock ? <Badge tone="warn">Low stock</Badge> : <Badge tone="good">{p.stock.available} available</Badge>}</span>}
      />
      {notice && <Alert tone="good" className="mb-4">{notice}</Alert>}
      {created && !notice && <Alert tone="good" className="mb-4" title="Product created">Customers can order it with the code {p.productCode}{p.status !== 'ACTIVE' ? ' once you set it to Active' : ''}.</Alert>}
      <ProductForm key={p.updatedAt} product={p} onSaved={(np, n) => { product.setData(np); setNotice(n); }} />
    </div>
  );
}

export default function ProductPage() {
  return <Suspense fallback={<PageLoading />}><EditProduct /></Suspense>;
}
