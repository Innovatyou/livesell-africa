'use client';

import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import { Dialog } from '@/components/dialog';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, ButtonLink, Card, EmptyState, ErrorState, Input, Select, Skeleton, cx } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { downloadCsv } from '@/lib/download';
import { formatMoney } from '@/lib/money';
import type { Category, ImportSummary, Page, ProductListItem, ProductStatus } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const STATUS_TONE: Record<ProductStatus, 'good' | 'neutral' | 'warn'> = { ACTIVE: 'good', DRAFT: 'neutral', ARCHIVED: 'warn' };
const STATUS_LABEL: Record<ProductStatus, string> = { ACTIVE: 'Active', DRAFT: 'Draft', ARCHIVED: 'Archived' };

export default function ProductsPage() {
  const { can } = useAuth();
  const canWrite = can('products:write');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [stock, setStock] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (query) p.set('search', query);
    if (status) p.set('status', status);
    if (stock) p.set('stock', stock);
    if (categoryId) p.set('categoryId', categoryId);
    return p.toString();
  }, [page, query, status, stock, categoryId]);
  const list = useApi<Page<ProductListItem>>(`/products?${qs}`);
  const categories = useApi<Category[]>('/categories');
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const filtered = !!(query || status || stock || categoryId);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOnPage = list.data?.items.length ? list.data.items.every((p) => selected.has(p.id)) : false;

  async function bulk(body: Record<string, unknown>, label: string) {
    setMsg(null);
    try {
      const r = await api<{ updated: number }>('/products/bulk', { method: 'POST', body: { productIds: [...selected], ...body } });
      setMsg({ tone: 'good', text: `${label}: ${r.updated} product${r.updated === 1 ? '' : 's'} updated.` });
      setSelected(new Set());
      await list.reload();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    }
  }

  return (
    <>
      <PageHeader
        title="Products"
        description="Every product has a code customers can send you, e.g. BAG001."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => downloadCsv('/products/export', 'products.csv').catch((e) => setMsg({ tone: 'bad', text: errorMessage(e) }))}>Export CSV</Button>
            {canWrite && <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>Import CSV</Button>}
            {canWrite && <ButtonLink href="/products/categories" variant="secondary" size="sm">Categories</ButtonLink>}
            {canWrite && <ButtonLink href="/products/new" size="sm">New product</ButtonLink>}
          </div>
        }
      />
      {msg && <Alert tone={msg.tone} className="mb-4">{msg.text}</Alert>}

      <Card>
        <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
          <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(search.trim()); }}>
            <label className="sr-only" htmlFor="product-search">Search products</label>
            <Input id="product-search" placeholder="Search name, code or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button type="submit" variant="secondary">Search</Button>
          </form>
          <div className="grid grid-cols-3 gap-2 lg:w-[480px]">
            <Select aria-label="Status" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
              <option value="">All statuses</option><option value="ACTIVE">Active</option><option value="DRAFT">Draft</option><option value="ARCHIVED">Archived</option>
            </Select>
            <Select aria-label="Stock" value={stock} onChange={(e) => { setPage(1); setStock(e.target.value); }}>
              <option value="">All stock</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option>
            </Select>
            <Select aria-label="Category" value={categoryId} onChange={(e) => { setPage(1); setCategoryId(e.target.value); }}>
              <option value="">All categories</option>
              {categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
        </div>

        {canWrite && selected.size > 0 && <BulkBar count={selected.size} categories={categories.data ?? []} onAction={bulk} onClear={() => setSelected(new Set())} />}

        {list.error ? <div className="p-5"><ErrorState message={list.error} onRetry={list.reload} /></div>
          : !list.data ? <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          : list.data.items.length === 0 ? (
            filtered
              ? <EmptyState title="No products match">Try a different search or clear the filters.</EmptyState>
              : <EmptyState title="Add your first product" action={canWrite ? <ButtonLink href="/products/new">New product</ButtonLink> : undefined}>Products appear on your storefront once they&apos;re active.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3">
                  <tr className="border-b border-line">
                    {canWrite && <th className="w-10 px-4 py-2.5"><input type="checkbox" aria-label="Select all on this page" checked={allOnPage} onChange={() => setSelected((s) => { const n = new Set(s); for (const p of list.data!.items) { if (allOnPage) n.delete(p.id); else n.add(p.id); } return n; })} /></th>}
                    <th className="px-4 py-2.5 font-medium">Product</th><th className="px-4 py-2.5 font-medium">Code</th><th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">Price</th><th className="px-4 py-2.5 text-right font-medium">Available</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {list.data.items.map((p) => (
                    <tr key={p.id} className={cx(selected.has(p.id) && 'bg-brand-50/40')}>
                      {canWrite && <td className="px-4 py-3"><input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} /></td>}
                      <td className="px-4 py-3">
                        <Link href={`/products/${p.id}`} className="flex items-center gap-3">
                          <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-sunken">
                            {p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" className="size-full object-cover" /> : <span className="text-[11px] text-ink-4">No image</span>}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-ink hover:text-brand-700">{p.name}</span>
                            <span className="block text-[12px] text-ink-3">{p.categoryName ?? 'No category'} · {p.variantCount} variant{p.variantCount === 1 ? '' : 's'}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-[13px]">{p.productCode}</td>
                      <td className="px-4 py-3"><Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge></td>
                      <td className="px-4 py-3 text-right tabular">{p.priceMin === null ? '—' : p.priceMin === p.priceMax ? formatMoney(p.priceMin) : `${formatMoney(p.priceMin)} – ${formatMoney(p.priceMax)}`}</td>
                      <td className="px-4 py-3 text-right tabular">
                        {p.outOfStock ? <Badge tone="bad">Out of stock</Badge> : p.lowStock ? <Badge tone="warn">{p.available} · low</Badge> : p.available}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        {list.data && list.data.total > list.data.pageSize && (
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm">
            <span className="text-ink-3">{list.data.total} products · page {page} of {pages}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        )}
      </Card>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={(s) => { setImportOpen(false); setMsg({ tone: 'good', text: `Imported: ${s.productsCreated} new and ${s.productsUpdated} updated products (${s.variantsCreated + s.variantsUpdated} variants).` }); void list.reload(); void categories.reload(); }} />
    </>
  );
}

function BulkBar({ count, categories, onAction, onClear }: { count: number; categories: Category[]; onAction: (body: Record<string, unknown>, label: string) => Promise<void>; onClear: () => void }) {
  const [action, setAction] = useState('set_status:ACTIVE');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const needsInput = action === 'add_tags' || action === 'remove_tags' || action === 'adjust_price' || action === 'set_category';
  const run = async () => {
    const [kind, arg] = action.split(':');
    const body: Record<string, unknown> =
      kind === 'set_status' ? { action: kind, status: arg }
      : kind === 'set_category' ? { action: kind, categoryId: value || null }
      : kind === 'adjust_price' ? { action: kind, percent: Number(value) }
      : { action: kind, tags: value.split(',').map((t) => t.trim()).filter(Boolean) };
    setBusy(true);
    await onAction(body, { set_status: 'Status changed', set_category: 'Category changed', add_tags: 'Tags added', remove_tags: 'Tags removed', adjust_price: 'Prices adjusted' }[kind] ?? 'Updated');
    setBusy(false);
  };
  const invalid = (action === 'adjust_price' && !/^-?\d{1,3}$/.test(value)) || ((action === 'add_tags' || action === 'remove_tags') && !value.trim());
  return (
    <div className="flex flex-col gap-2 border-b border-line bg-brand-50/50 px-4 py-3 sm:flex-row sm:items-center">
      <p className="text-sm font-medium text-ink">{count} selected</p>
      <div className="flex flex-1 flex-wrap gap-2 sm:justify-end">
        <Select aria-label="Bulk action" className="h-9 w-48" value={action} onChange={(e) => { setAction(e.target.value); setValue(''); }}>
          <option value="set_status:ACTIVE">Make active</option><option value="set_status:DRAFT">Move to draft</option><option value="set_status:ARCHIVED">Archive</option>
          <option value="set_category">Set category</option><option value="add_tags">Add tags</option><option value="remove_tags">Remove tags</option><option value="adjust_price">Change prices by %</option>
        </Select>
        {needsInput && (action === 'set_category' ? (
          <Select aria-label="Category" className="h-9 w-44" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">No category</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        ) : (
          <Input aria-label={action === 'adjust_price' ? 'Percent' : 'Tags'} className="h-9 w-44" placeholder={action === 'adjust_price' ? 'e.g. -10 or 15' : 'sale, new'} value={value} onChange={(e) => setValue(e.target.value)} />
        ))}
        <Button size="sm" loading={busy} disabled={invalid} onClick={() => void run()}>Apply</Button>
        <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
      </div>
    </div>
  );
}

function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (s: ImportSummary) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [errors, setErrors] = useState<Array<{ row: number; message: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => { setCsv(null); setName(''); setPreview(null); setErrors([]); setError(null); if (input.current) input.current.value = ''; };

  async function pick(file?: File) {
    reset();
    if (!file) return;
    if (file.size > 2_000_000) return setError('The file is larger than 2 MB. Split it into smaller files.');
    const text = await file.text();
    setCsv(text);
    setName(file.name);
    await send(text, true);
  }

  async function send(text: string, dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<ImportSummary>('/products/import', { method: 'POST', body: { csv: text, dryRun } });
      if (dryRun) setPreview(r); else { onDone(r); reset(); }
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { errors?: Array<{ row: number; message: string }> }) : undefined;
      setErrors(body?.errors ?? []);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} wide title="Import products from CSV"
      description="One row per variant. Tip: export first to get the exact columns, edit in Excel or Google Sheets, then import."
      footer={<>
        <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
        <Button disabled={!csv || !preview} loading={busy && !!preview} onClick={() => csv && void send(csv, false)}>Import</Button>
      </>}
    >
      <div className="space-y-4 text-sm">
        <div className="flex items-center gap-3">
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" id="csv-file" onChange={(e) => void pick(e.target.files?.[0])} />
          <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>{csv ? 'Choose another file' : 'Choose CSV file'}</Button>
          <span className="truncate text-ink-3">{name || 'No file chosen'}</span>
        </div>
        <p className="text-[13px] text-ink-3">Required columns: <code>name</code>, <code>price</code> (naira, e.g. 25000 or 25,000.50). Optional: product_code, description, category, status, tags (a;b), attributes (Colour=Black; Size=L), sku, promo_price, cost_price, stock, active, weight_grams, low_stock_threshold. Rows with the same product_code are variants of one product.</p>
        {busy && !preview && <p className="text-ink-3">Checking the file…</p>}
        {preview && (
          <Alert tone="info" title="Ready to import">
            {preview.rows} rows: {preview.productsCreated} new products, {preview.productsUpdated} updated; {preview.variantsCreated} new variants, {preview.variantsUpdated} updated. Nothing is saved until you click Import.
          </Alert>
        )}
        {error && <Alert tone="bad">{error}</Alert>}
        {errors.length > 0 && (
          <div className="max-h-56 overflow-auto rounded-lg border border-line">
            <table className="w-full text-[13px]"><tbody className="divide-y divide-line">
              {errors.map((e, i) => <tr key={i}><td className="w-16 px-3 py-1.5 text-ink-3">Row {e.row}</td><td className="px-3 py-1.5">{e.message}</td></tr>)}
            </tbody></table>
          </div>
        )}
      </div>
    </Dialog>
  );
}
