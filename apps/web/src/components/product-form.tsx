'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { koboToNairaInput, nairaToKobo } from '@/lib/money';
import type { Category, Movement, Product, ProductStatus } from '@/lib/types';
import { uploadFile } from '@/lib/upload';
import { useApi } from '@/lib/use-api';
import { Dialog } from './dialog';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Textarea, cx } from './ui';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/webm'];

interface MediaDraft { key: string; type: 'image' | 'video'; url: string; alt: string }
interface OptionDraft { name: string; values: string }
interface Row {
  id?: string; attributes: Record<string, string>; price: string; promo: string; cost: string; sku: string;
  initialStock: string; isActive: boolean; inventory?: { onHand: number; reserved: number; available: number };
}

const comboKey = (a: Record<string, string>) => Object.entries(a).map(([k, v]) => `${k.toLowerCase()}=${v.toLowerCase()}`).sort().join('|');

function cartesian(options: Array<{ name: string; values: string[] }>): Array<Record<string, string>> {
  return options.reduce<Array<Record<string, string>>>((acc, o) => acc.flatMap((a) => o.values.map((v) => ({ ...a, [o.name]: v }))), [{}]);
}

function rowFromVariant(v: Product['variants'][number]): Row {
  return {
    id: v.id, attributes: v.attributes, price: koboToNairaInput(v.priceMinor), promo: koboToNairaInput(v.promoPriceMinor),
    cost: koboToNairaInput(v.costPriceMinor), sku: v.sku, initialStock: '', isActive: v.isActive, inventory: v.inventory,
  };
}

/** onSaved receives the fresh product and a notice; the edit page remounts the form so new variant ids are picked up. */
export function ProductForm({ product, onSaved }: { product?: Product; onSaved?: (p: Product, notice: string) => void }) {
  const router = useRouter();
  const { can, workspace } = useAuth();
  const canWrite = can('products:write');
  const canStock = can('inventory:write');
  const categories = useApi<Category[]>('/categories');
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [code, setCode] = useState(product?.productCode ?? '');
  // New products: the code follows the name ("Red Leather Handbag" → BAG007) until the seller types their own.
  const [codeTouched, setCodeTouched] = useState(!!product);
  const [categoryId, setCategoryId] = useState(product?.category?.id ?? '');
  const [status, setStatus] = useState<ProductStatus>(product?.status ?? 'DRAFT');
  const [tags, setTags] = useState(product?.tags.join(', ') ?? '');
  const [threshold, setThreshold] = useState(String(product?.lowStockThreshold ?? 5));
  const [weight, setWeight] = useState(product?.weightGrams?.toString() ?? '');
  const [media, setMedia] = useState<MediaDraft[]>(product?.media.map((m) => ({ key: m.key, type: m.type, url: m.url, alt: m.alt ?? '' })) ?? []);
  const [options, setOptions] = useState<OptionDraft[]>(product?.options.map((o) => ({ name: o.name, values: o.values.join(', ') })) ?? []);
  const allRows = useMemo(() => new Map((product?.variants ?? []).map((v) => [comboKey(v.attributes), rowFromVariant(v)])), [product]);
  const [rows, setRows] = useState<Map<string, Row>>(() => {
    if (product) return new Map(product.variants.filter((v) => v.isActive).map((v) => [comboKey(v.attributes), rowFromVariant(v)]));
    return new Map([['', { attributes: {}, price: '', promo: '', cost: '', sku: '', initialStock: '', isActive: true }]]);
  });
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [stockFor, setStockFor] = useState<Row | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const parsedOptions = options
    .map((o) => ({ name: o.name.trim(), values: [...new Set(o.values.split(',').map((v) => v.trim()).filter(Boolean))] }))
    .filter((o) => o.name && o.values.length);

  /** Rebuilds the variant matrix from the options, keeping what was typed for combinations that still exist. */
  function regenerate(next: OptionDraft[]) {
    setOptions(next);
    const parsed = next.map((o) => ({ name: o.name.trim(), values: [...new Set(o.values.split(',').map((v) => v.trim()).filter(Boolean))] })).filter((o) => o.name && o.values.length);
    const combos = cartesian(parsed);
    setRows((prev) => {
      const out = new Map<string, Row>();
      for (const a of combos) {
        const k = comboKey(a);
        out.set(k, prev.get(k) ?? (allRows.get(k) ? { ...allRows.get(k)!, isActive: true } : { attributes: a, price: [...prev.values()][0]?.price ?? '', promo: '', cost: [...prev.values()][0]?.cost ?? '', sku: '', initialStock: '', isActive: true }));
      }
      return out;
    });
  }

  const setRow = (k: string, patch: Partial<Row>) => setRows((prev) => new Map(prev).set(k, { ...prev.get(k)!, ...patch }));

  const rowErrors = [...rows.entries()].map(([k, r]) => {
    const price = nairaToKobo(r.price);
    const promo = r.promo ? nairaToKobo(r.promo) : null;
    if (!price) return [k, 'Enter a price'] as const;
    if (r.promo && !promo) return [k, 'Invalid promo price'] as const;
    if (promo && BigInt(promo) > BigInt(price)) return [k, 'Promo price is above the price'] as const;
    if (r.cost && !nairaToKobo(r.cost)) return [k, 'Invalid cost price'] as const;
    if (r.initialStock && !/^\d{1,6}$/.test(r.initialStock)) return [k, 'Stock must be a whole number'] as const;
    return [k, null] as const;
  });
  const invalid = name.trim().length < 2 || rows.size === 0 || rowErrors.some(([, e]) => e) || (code !== '' && !/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code));

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setMsg(null);
    try {
      for (const file of [...files].slice(0, 10 - media.length)) {
        const isVideo = file.type.startsWith('video/');
        const key = await uploadFile('/products/media/upload-url', file, isVideo ? VIDEO_TYPES : IMAGE_TYPES, isVideo ? 50 * 1024 * 1024 : 5 * 1024 * 1024);
        setMedia((m) => [...m, { key, type: isVideo ? 'video' : 'image', url: URL.createObjectURL(file), alt: '' }]);
      }
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  const move = (i: number, d: -1 | 1) => setMedia((m) => { const n = [...m]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; });

  useEffect(() => {
    if (codeTouched || name.trim().length < 2) return;
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ name: name.trim(), ...(categoryId ? { categoryId } : {}) });
      api<{ productCode: string }>(`/products/code-suggestion?${qs}`).then((r) => setCode(r.productCode)).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [name, categoryId, codeTouched]);

  async function suggest() {
    try {
      const qs = new URLSearchParams({ name: name || 'Item', ...(categoryId ? { categoryId } : {}) });
      setCode((await api<{ productCode: string }>(`/products/code-suggestion?${qs}`)).productCode);
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setBusy(true);
    setMsg(null);
    const inactive = product ? product.variants.filter((v) => !rows.has(comboKey(v.attributes)) && v.isActive).map(rowFromVariant) : [];
    const variants = [...rows.values(), ...inactive.map((r) => ({ ...r, isActive: false }))].map((r) => ({
      ...(r.id ? { id: r.id } : {}), attributes: r.attributes, ...(r.sku.trim() ? { sku: r.sku.trim() } : {}),
      priceMinor: nairaToKobo(r.price)!, promoPriceMinor: r.promo ? nairaToKobo(r.promo) : null, costPriceMinor: r.cost ? nairaToKobo(r.cost) : null,
      ...(!r.id && r.initialStock ? { initialStock: Number(r.initialStock) } : {}), isActive: r.isActive,
    }));
    const body = {
      name: name.trim(), description: description.trim(), status, categoryId: categoryId || null,
      ...(code ? { productCode: code } : {}),
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean), lowStockThreshold: Number(threshold) || 0,
      weightGrams: weight ? Number(weight) : null, media: media.map((m) => ({ key: m.key, type: m.type, ...(m.alt ? { alt: m.alt } : {}) })), variants,
    };
    try {
      const saved = product
        ? await api<Product>(`/products/${product.id}`, { method: 'PATCH', body })
        : await api<Product>('/products', { method: 'POST', body });
      if (product) onSaved?.(saved, 'Product saved.');
      else router.replace(`/products/${saved.id}?created=1`);
    } catch (err) {
      setMsg({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!product || !window.confirm(`Delete ${product.name}? It will disappear from your store. Its code ${product.productCode} stays reserved.`)) return;
    try {
      await api(`/products/${product.id}`, { method: 'DELETE' });
      router.replace('/products');
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    }
  }

  const hasOptions = parsedOptions.length > 0;
  const storeLink = product?.status === 'ACTIVE' && workspace ? `/store/${workspace.slug}/p/${product.slug}` : null;

  return (
    <form onSubmit={save} noValidate className="space-y-6">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <fieldset disabled={!canWrite || busy} className="space-y-6">
        <Card>
          <CardHeader title="Details" action={storeLink && <Link href={storeLink} target="_blank" className="text-sm font-medium text-brand-700 hover:underline">View on storefront ↗</Link>} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Product name" className="sm:col-span-2" error={name && name.trim().length < 2 ? 'At least 2 characters' : null}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Premium Leather Bag" />}</Field>
            <Field label="Product code" hint="Filled in from the name (you can change it). Customers send this to order, e.g. BAG001." error={code && !/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code) ? '2–20 letters, digits or hyphens' : null}>
              {(p) => (
                <div className="flex gap-2">
                  <Input {...p} className="font-mono uppercase" value={code} onChange={(e) => { setCodeTouched(true); setCode(e.target.value.toUpperCase().replace(/\s+/g, '')); }} placeholder="Auto" />
                  <Button type="button" variant="secondary" onClick={() => void suggest()}>Suggest</Button>
                </div>
              )}
            </Field>
            <Field label="Status" hint="Only active products appear on your storefront.">
              {(p) => <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as ProductStatus)}><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="ARCHIVED">Archived</option></Select>}
            </Field>
            <Field label="Category">
              {(p) => <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">No category</option>{categories.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
            </Field>
            <Field label="Tags" hint="Comma separated, e.g. leather, new">{(p) => <Input {...p} value={tags} onChange={(e) => setTags(e.target.value)} />}</Field>
            <Field label="Description" className="sm:col-span-2">{(p) => <Textarea {...p} rows={4} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
            <Field label="Low-stock alert at" hint="Warn when available units fall to this number.">{(p) => <Input {...p} inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value.replace(/\D/g, ''))} />}</Field>
            <Field label="Weight (grams)" hint="Used for delivery fees later.">{(p) => <Input {...p} inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value.replace(/\D/g, ''))} />}</Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Photos and videos" description="Up to 10. PNG, JPG or WebP up to 5 MB; MP4 or WebM up to 50 MB. The first image is the main one." />
          <div className="p-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {media.map((m, i) => (
                <div key={m.key} className="rounded-lg border border-line p-2">
                  <div className="aspect-square overflow-hidden rounded-md bg-sunken">
                    {m.type === 'image' ? <img src={m.url} alt={m.alt} className="size-full object-cover" /> : <video src={m.url} className="size-full object-cover" muted />}
                  </div>
                  <Input aria-label="Alt text" className="mt-2 h-8 text-[13px]" placeholder="Describe it" value={m.alt} onChange={(e) => setMedia((all) => all.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)))} />
                  <div className="mt-1 flex justify-between">
                    <div className="flex gap-1">
                      <Button type="button" size="sm" variant="ghost" disabled={i === 0} aria-label="Move earlier" onClick={() => move(i, -1)}>←</Button>
                      <Button type="button" size="sm" variant="ghost" disabled={i === media.length - 1} aria-label="Move later" onClick={() => move(i, 1)}>→</Button>
                    </div>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setMedia((all) => all.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                </div>
              ))}
              {media.length < 10 && canWrite && (
                <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading}
                  className="grid aspect-square place-items-center rounded-lg border border-dashed border-line-strong text-sm text-ink-3 hover:border-brand-500 hover:text-brand-700">
                  {uploading ? 'Uploading…' : '+ Add files'}
                </button>
              )}
            </div>
            <input ref={fileInput} type="file" multiple accept={[...IMAGE_TYPES, ...VIDEO_TYPES].join(',')} className="sr-only" onChange={(e) => void addFiles(e.target.files)} />
          </div>
        </Card>

        <Card>
          <CardHeader title="Variants and pricing" description="Add options like Colour or Size to create a variant for every combination. Prices in naira." />
          <div className="space-y-4 p-5">
            {options.map((o, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[180px_1fr_auto] sm:items-end">
                <Field label={`Option ${i + 1}`}>{(p) => <Input {...p} placeholder="Colour" value={o.name} onChange={(e) => regenerate(options.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />}</Field>
                <Field label="Values" hint="Comma separated">{(p) => <Input {...p} placeholder="Black, Brown, Wine" value={o.values} onChange={(e) => regenerate(options.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))} />}</Field>
                <Button type="button" variant="ghost" onClick={() => regenerate(options.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            {options.length < 4 && <Button type="button" variant="secondary" size="sm" onClick={() => setOptions([...options, { name: '', values: '' }])}>+ Add option</Button>}

            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-sunken text-left text-[12px] text-ink-3">
                  <tr>
                    {hasOptions && <th className="px-3 py-2 font-medium">Variant</th>}
                    <th className="px-3 py-2 font-medium">Price (₦)</th><th className="px-3 py-2 font-medium">Promo (₦)</th><th className="px-3 py-2 font-medium">Cost (₦)</th>
                    <th className="px-3 py-2 font-medium">SKU</th><th className="px-3 py-2 font-medium">Stock</th>{hasOptions && <th className="px-3 py-2 font-medium">Sell</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[...rows.entries()].map(([k, r]) => {
                    const err = rowErrors.find(([rk]) => rk === k)?.[1];
                    return (
                      <tr key={k || 'default'} className={cx(!r.isActive && 'opacity-60')}>
                        {hasOptions && <td className="px-3 py-2 font-medium">{Object.values(r.attributes).join(' / ')}</td>}
                        <td className="px-3 py-2"><Input aria-label="Price" aria-invalid={err === 'Enter a price' || undefined} className="h-9 w-28" inputMode="decimal" value={r.price} onChange={(e) => setRow(k, { price: e.target.value })} placeholder="25,000" /></td>
                        <td className="px-3 py-2"><Input aria-label="Promo price" className="h-9 w-28" inputMode="decimal" value={r.promo} onChange={(e) => setRow(k, { promo: e.target.value })} /></td>
                        <td className="px-3 py-2"><Input aria-label="Cost price" className="h-9 w-28" inputMode="decimal" value={r.cost} onChange={(e) => setRow(k, { cost: e.target.value })} /></td>
                        <td className="px-3 py-2"><Input aria-label="SKU" className="h-9 w-36 font-mono text-[13px]" value={r.sku} onChange={(e) => setRow(k, { sku: e.target.value })} placeholder="Auto" /></td>
                        <td className="px-3 py-2">
                          {r.inventory ? (
                            <div className="flex items-center gap-2">
                              <span className="tabular" title={`${r.inventory.onHand} on hand, ${r.inventory.reserved} reserved`}>{r.inventory.available}</span>
                              {canStock && <Button type="button" size="sm" variant="ghost" onClick={() => setStockFor(r)}>Adjust</Button>}
                            </div>
                          ) : (
                            <Input aria-label="Opening stock" className="h-9 w-20" inputMode="numeric" value={r.initialStock} onChange={(e) => setRow(k, { initialStock: e.target.value.replace(/\D/g, '') })} placeholder="0" />
                          )}
                          {err && <p className="mt-1 text-[12px] text-bad">{err}</p>}
                        </td>
                        {hasOptions && <td className="px-3 py-2"><input type="checkbox" aria-label="Available for sale" checked={r.isActive} onChange={(e) => setRow(k, { isActive: e.target.checked })} /></td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.size > 100 && <Alert tone="bad">At most 100 variants per product.</Alert>}
          </div>
        </Card>
      </fieldset>

      {product && <MovementHistory productId={product.id} key={product.updatedAt} />}

      {canWrite && (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas/95 py-4 backdrop-blur">
          {product && <Button type="button" variant="danger" className="mr-auto" onClick={() => void remove()}>Delete product</Button>}
          <Button type="submit" loading={busy} disabled={invalid || uploading || rows.size > 100}>{product ? 'Save changes' : 'Create product'}</Button>
        </div>
      )}

      {stockFor && product && (
        <StockDialog row={stockFor} productName={product.name} onClose={() => setStockFor(null)} onDone={async () => {
          setStockFor(null);
          const fresh = await api<Product>(`/products/${product.id}`);
          setRows((prev) => {
            const out = new Map(prev);
            for (const v of fresh.variants) { const k = comboKey(v.attributes); if (out.has(k)) out.set(k, { ...out.get(k)!, inventory: v.inventory }); }
            return out;
          });
          onSaved?.(fresh, 'Stock updated.');
        }} />
      )}
    </form>
  );
}

export function StockDialog({ row, productName, onClose, onDone }: { row: { id?: string; attributes: Record<string, string>; inventory?: { onHand: number; reserved: number; available: number } }; productName: string; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'add' | 'remove' | 'set'>('add');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = Object.values(row.attributes).join(' / ') || 'Default';
  const n = Number(qty);
  const valid = /^\d{1,6}$/.test(qty) && reason.trim().length >= 2 && (mode === 'set' || n > 0);
  async function submit() {
    if (!row.id) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/inventory/variants/${row.id}/adjust`, { method: 'POST', body: { mode, quantity: n, reason: reason.trim(), ...(mode === 'add' && /return/i.test(reason) ? { type: 'RETURN' } : {}) } });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={`Adjust stock · ${productName}`} description={`${label} — ${row.inventory?.onHand ?? 0} on hand, ${row.inventory?.reserved ?? 0} reserved for open orders`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!valid} onClick={() => void submit()}>Save</Button></>}>
      <div className="space-y-4">
        {error && <Alert tone="bad">{error}</Alert>}
        <div role="radiogroup" aria-label="Adjustment type" className="grid grid-cols-3 gap-2">
          {([['add', 'Add'], ['remove', 'Remove'], ['set', 'Set count']] as const).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={mode === v} onClick={() => setMode(v)}
              className={cx('rounded-lg border px-3 py-2 text-sm font-medium', mode === v ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-line-strong text-ink-2')}>{l}</button>
          ))}
        </div>
        <Field label={mode === 'set' ? 'Counted quantity' : 'Quantity'}>{(p) => <Input {...p} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />}</Field>
        <Field label="Reason" hint="Shown in the stock history, e.g. Supplier delivery, Damaged, Stock count">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

const MOVEMENT_LABEL: Record<Movement['type'], string> = { RESTOCK: 'Restock', ADJUSTMENT: 'Adjustment', RESERVATION: 'Reserved', RELEASE: 'Released', SALE: 'Sold', RETURN: 'Returned' };

export function MovementHistory({ productId }: { productId?: string }) {
  const { can } = useAuth();
  const moves = useApi<Movement[]>(can('inventory:read') ? `/inventory/movements${productId ? `?productId=${productId}` : ''}` : null);
  if (!can('inventory:read')) return null;
  return (
    <Card>
      <CardHeader title="Stock history" description="Every change, with the balance after it" />
      {moves.error ? <div className="p-5"><Alert tone="bad">{moves.error}</Alert></div>
        : !moves.data ? <p className="p-5 text-sm text-ink-3">Loading…</p>
        : moves.data.length === 0 ? <p className="p-5 text-sm text-ink-3">No stock changes yet.</p>
        : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3"><tr className="border-b border-line">
                <th className="px-5 py-2 font-medium">When</th><th className="px-5 py-2 font-medium">Variant</th><th className="px-5 py-2 font-medium">Change</th>
                <th className="px-5 py-2 font-medium">Reason</th><th className="px-5 py-2 text-right font-medium">On hand</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {moves.data.map((m) => (
                  <tr key={m.id}>
                    <td className="px-5 py-2 text-ink-3">{new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(m.createdAt))}</td>
                    <td className="px-5 py-2"><span className="font-mono text-[12px]">{m.inventory.variant.sku}</span></td>
                    <td className="px-5 py-2"><Badge tone={m.quantity >= 0 ? 'good' : 'neutral'}>{MOVEMENT_LABEL[m.type]} {m.quantity > 0 ? `+${m.quantity}` : m.quantity}</Badge></td>
                    <td className="px-5 py-2 text-ink-2">{m.reason ?? (m.orderId ? 'Order' : '—')}</td>
                    <td className="px-5 py-2 text-right tabular">{m.onHandAfter ?? '—'}{m.reservedAfter ? <span className="text-ink-3"> ({m.reservedAfter} reserved)</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Card>
  );
}

