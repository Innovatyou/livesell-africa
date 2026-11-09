'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { MovementHistory, StockDialog } from '@/components/product-form';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import type { LowStockRow } from '@/lib/types';
import { useApi } from '@/lib/use-api';

export default function InventoryPage() {
  const { can } = useAuth();
  const low = useApi<LowStockRow[]>('/inventory/low-stock');
  const [adjusting, setAdjusting] = useState<LowStockRow | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  if (!can('inventory:read')) return <Card><EmptyState title="Your role can't view inventory" /></Card>;

  return (
    <>
      <PageHeader title="Inventory" description="Available = on hand minus units reserved for open orders." />
      {msg && <Alert tone="good" className="mb-4">{msg}</Alert>}
      <Card className="mb-6">
        <CardHeader title="Low stock" description="Variants at or below their product's alert level" />
        {low.error ? <div className="p-5"><ErrorState message={low.error} onRetry={low.reload} /></div>
          : !low.data ? <div className="space-y-3 p-5"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
          : low.data.length === 0 ? <EmptyState title="Nothing is running low">You&apos;ll see variants here when they reach their low-stock alert level.</EmptyState>
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3"><tr className="border-b border-line">
                  <th className="px-5 py-2.5 font-medium">Product</th><th className="px-5 py-2.5 font-medium">SKU</th>
                  <th className="px-5 py-2.5 text-right font-medium">On hand</th><th className="px-5 py-2.5 text-right font-medium">Reserved</th>
                  <th className="px-5 py-2.5 text-right font-medium">Available</th><th className="px-5 py-2.5" />
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {low.data.map((r) => (
                    <tr key={r.variantId}>
                      <td className="px-5 py-3"><Link href={`/products/${r.productId}`} className="font-medium hover:text-brand-700">{r.productName}</Link>{r.variantName !== 'Default' && <span className="text-ink-3"> · {r.variantName}</span>}</td>
                      <td className="px-5 py-3 font-mono text-[12px]">{r.sku}</td>
                      <td className="px-5 py-3 text-right tabular">{r.onHand}</td>
                      <td className="px-5 py-3 text-right tabular">{r.reserved}</td>
                      <td className="px-5 py-3 text-right">{r.available <= 0 ? <Badge tone="bad">Out</Badge> : <Badge tone="warn">{r.available}</Badge>}</td>
                      <td className="px-5 py-3 text-right">{can('inventory:write') && <Button size="sm" variant="secondary" onClick={() => setAdjusting(r)}>Restock</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
      <MovementHistory key={version} />
      {adjusting && (
        <StockDialog
          row={{ id: adjusting.variantId, attributes: adjusting.variantName === 'Default' ? {} : { Variant: adjusting.variantName }, inventory: { onHand: adjusting.onHand, reserved: adjusting.reserved, available: adjusting.available } }}
          productName={adjusting.productName} onClose={() => setAdjusting(null)}
          onDone={() => { setAdjusting(null); setMsg(`Stock updated for ${adjusting.productName}.`); setVersion((v) => v + 1); void low.reload(); }}
        />
      )}
    </>
  );
}
