'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatMoney, koboToNairaInput, nairaToKobo } from '@/lib/money';
import { E164, normalisePhone } from '@/lib/nav';
import type { Customer, CustomerListItem, Order, Page, Product, SalesChannel } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import { Alert, Button, Card, CardHeader, Field, Input, Select, Textarea } from './ui';

interface Line { variantId: string; productCode: string; productName: string; variantName: string; unitPriceMinor: string; quantity: string; discount: string }

/**
 * Manual order entry (and editing of draft / awaiting-payment orders). Items are added by product code, the way
 * orders arrive during lives and on WhatsApp. Prices shown are a preview; the server computes the real totals.
 */
export function OrderForm({ order, liveSessionId, sessionPrices, compact, onCreated }: {
  order?: Order; liveSessionId?: string; sessionPrices?: Map<string, string | null>; compact?: boolean; onCreated?: (o: Order) => void;
}) {
  const router = useRouter();
  const channels = useApi<SalesChannel[]>(liveSessionId ? null : '/sales-channels');
  const [customerMode, setCustomerMode] = useState<'existing' | 'new' | 'none'>(order?.customer ? 'existing' : 'new');
  const [customer, setCustomer] = useState<{ id: string; fullName: string; phone: string | null } | null>(order?.customer ?? null);
  const [custQuery, setCustQuery] = useState('');
  const [matches, setMatches] = useState<CustomerListItem[]>([]);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [lines, setLines] = useState<Line[]>(() => (order?.items ?? []).map((i) => ({
    variantId: i.variantId, productCode: i.productCode ?? i.sku, productName: i.productName, variantName: i.variantName,
    unitPriceMinor: i.unitPriceMinor, quantity: String(i.quantity), discount: koboToNairaInput(i.discountMinor === '0' ? null : i.discountMinor),
  })));
  const [code, setCode] = useState('');
  const [qty, setQty] = useState('1');
  const [picking, setPicking] = useState<Product | null>(null);
  const [delivery, setDelivery] = useState(koboToNairaInput(order && order.deliveryFeeMinor !== '0' ? order.deliveryFeeMinor : null));
  const [discount, setDiscount] = useState(koboToNairaInput(order && order.discountMinor !== '0' ? order.discountMinor : null));
  const [addressId, setAddressId] = useState('');
  const [address, setAddress] = useState({ line1: order?.shippingAddress?.line1 ?? '', city: order?.shippingAddress?.city ?? '', state: order?.shippingAddress?.state ?? '', landmark: order?.shippingAddress?.landmark ?? '' });
  const [savedAddresses, setSavedAddresses] = useState<Customer['addresses']>([]);
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [channelId, setChannelId] = useState(order?.channel?.id ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (customerMode !== 'existing' || customer || custQuery.trim().length < 2) { setMatches([]); return; }
    const t = setTimeout(() => {
      api<Page<CustomerListItem>>(`/customers?search=${encodeURIComponent(custQuery.trim())}&pageSize=5`).then((r) => setMatches(r.items)).catch(() => setMatches([]));
    }, 250);
    return () => clearTimeout(t);
  }, [custQuery, customer, customerMode]);

  useEffect(() => {
    if (!customer) { setSavedAddresses([]); return; }
    api<Customer>(`/customers/${customer.id}`).then((c) => setSavedAddresses(c.addresses)).catch(() => setSavedAddresses([]));
  }, [customer]);

  function addLine(p: Product, variant: Product['variants'][number], quantity: number) {
    const price = sessionPrices?.get(p.id) ?? variant.promoPriceMinor ?? variant.priceMinor;
    setLines((ls) => {
      const existing = ls.find((l) => l.variantId === variant.id);
      if (existing) return ls.map((l) => (l.variantId === variant.id ? { ...l, quantity: String(Number(l.quantity) + quantity) } : l));
      return [...ls, { variantId: variant.id, productCode: p.productCode, productName: p.name, variantName: variant.name, unitPriceMinor: price, quantity: String(quantity), discount: '' }];
    });
    setCode('');
    setQty('1');
    setPicking(null);
  }

  async function lookup(e?: React.FormEvent) {
    e?.preventDefault();
    const c = code.trim().toUpperCase().replace(/\s+/g, '');
    const n = Number(qty);
    if (!c || !Number.isInteger(n) || n < 1) return;
    setBusy('lookup');
    setError(null);
    try {
      const p = await api<Product>(`/products/by-code/${encodeURIComponent(c)}`);
      const active = p.variants.filter((v) => v.isActive);
      if (!active.length) setError(`${p.productCode} has no variant available for sale`);
      else if (active.length === 1) addLine(p, active[0], n);
      else setPicking(p);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? `No product with code ${c}` : errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const preview = useMemo(() => {
    let subtotal = 0n;
    for (const l of lines) {
      const q = BigInt(Number(l.quantity) || 0);
      subtotal += BigInt(l.unitPriceMinor) * q - BigInt(nairaToKobo(l.discount) ?? '0');
    }
    const total = subtotal - BigInt(nairaToKobo(discount) ?? '0') + BigInt(nairaToKobo(delivery) ?? '0');
    return { subtotal, total };
  }, [lines, discount, delivery]);

  const phoneErr = newPhone && !E164.test(normalisePhone(newPhone)) ? 'Enter a valid phone number' : null;
  const addressGiven = address.line1 || address.city || address.state;
  const addressErr = addressGiven && !(address.line1.trim().length >= 3 && address.city.trim().length >= 2 && address.state.trim().length >= 2) ? 'Complete the address (street, city and state)' : null;
  const lineErr = lines.some((l) => !/^\d{1,3}$/.test(l.quantity) || Number(l.quantity) < 1 || (l.discount && !nairaToKobo(l.discount)));
  const customerErr = customerMode === 'existing' ? !customer : customerMode === 'new' ? newName.trim().length < 2 || !newPhone || !!phoneErr : false;
  const invalid = !lines.length || lineErr || customerErr || !!addressErr || (!!delivery && !nairaToKobo(delivery)) || (!!discount && !nairaToKobo(discount)) || preview.total < 0n;

  async function submit(confirm: boolean) {
    setBusy(confirm ? 'confirm' : 'draft');
    setError(null);
    const body: Record<string, unknown> = {
      items: lines.map((l) => ({ variantId: l.variantId, quantity: Number(l.quantity), ...(l.discount ? { discountMinor: nairaToKobo(l.discount) } : {}) })),
      discountMinor: nairaToKobo(discount) ?? '0', deliveryFeeMinor: nairaToKobo(delivery) ?? '0', ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    if (customerMode === 'existing' && customer) body.customer = { customerId: customer.id };
    if (customerMode === 'new') body.customer = { fullName: newName.trim(), phone: normalisePhone(newPhone) };
    if (addressId) body.addressId = addressId;
    else if (addressGiven) body.shippingAddress = { line1: address.line1.trim(), city: address.city.trim(), state: address.state.trim(), ...(address.landmark.trim() ? { landmark: address.landmark.trim() } : {}) };
    try {
      let saved: Order;
      if (order) {
        saved = await api<Order>(`/orders/${order.id}`, { method: 'PATCH', body });
      } else {
        saved = await api<Order>('/orders', { method: 'POST', body: { ...body, confirm, ...(liveSessionId ? { liveSessionId } : channelId ? { channelId } : {}) } });
      }
      if (onCreated) {
        onCreated(saved);
        setLines([]); setNewName(''); setNewPhone(''); setCustomer(null); setCustQuery(''); setAddress({ line1: '', city: '', state: '', landmark: '' }); setNotes(''); setDelivery(''); setDiscount('');
      } else {
        router.push(`/orders/${saved.id}${order ? '?saved=1' : ''}`);
      }
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK'
        ? `Not enough stock: ${((err.body as { shortages?: Array<{ variantId: string; available: number }> })?.shortages ?? []).map((s) => `${lines.find((l) => l.variantId === s.variantId)?.productCode ?? 'item'} has ${s.available} available`).join(', ')}`
        : errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="bad">{error}</Alert>}
      <Card>
        <CardHeader title="Items" description="Type the product code the customer sent, e.g. BAG001" />
        <div className="space-y-3 p-4">
          <form onSubmit={lookup} className="flex flex-wrap gap-2">
            <Input aria-label="Product code" className="w-40 font-mono uppercase" placeholder="BAG001" value={code} onChange={(e) => setCode(e.target.value)} />
            <Input aria-label="Quantity" className="w-20" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
            <Button type="submit" variant="secondary" loading={busy === 'lookup'} disabled={!code.trim()}>Add</Button>
          </form>
          {picking && (
            <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-3">
              <p className="mb-2 text-sm font-medium">{picking.productCode} {picking.name} — which one?</p>
              <div className="flex flex-wrap gap-2">
                {picking.variants.filter((v) => v.isActive).map((v) => (
                  <Button key={v.id} size="sm" variant="secondary" disabled={v.inventory.available <= 0} onClick={() => addLine(picking, v, Number(qty) || 1)}>
                    {v.name} · {v.inventory.available <= 0 ? 'out' : `${v.inventory.available} left`}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setPicking(null)}>Cancel</Button>
              </div>
            </div>
          )}
          {lines.length === 0 ? <p className="text-sm text-ink-3">No items yet.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="text-left text-[12px] text-ink-3"><tr><th className="py-1.5 font-medium">Item</th><th className="py-1.5 font-medium">Price</th><th className="py-1.5 font-medium">Qty</th><th className="py-1.5 font-medium">Discount (₦)</th><th /></tr></thead>
                <tbody className="divide-y divide-line">
                  {lines.map((l, i) => (
                    <tr key={l.variantId}>
                      <td className="py-2"><span className="font-mono text-[12px] text-ink-3">{l.productCode}</span> {l.productName}{l.variantName !== 'Default' && <span className="text-ink-3"> · {l.variantName}</span>}</td>
                      <td className="py-2 tabular">{formatMoney(l.unitPriceMinor)}</td>
                      <td className="py-2"><Input aria-label="Quantity" className="h-8 w-16" inputMode="numeric" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value.replace(/\D/g, '') } : x)))} /></td>
                      <td className="py-2"><Input aria-label="Line discount" className="h-8 w-24" inputMode="decimal" value={l.discount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, discount: e.target.value } : x)))} /></td>
                      <td className="py-2 text-right"><Button size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Customer" />
        <div className="space-y-3 p-4">
          <div role="radiogroup" aria-label="Customer" className="flex flex-wrap gap-2 text-sm">
            {([['new', 'New customer'], ['existing', 'Existing customer'], ['none', 'No customer']] as const).map(([v, l]) => (
              <label key={v} className="flex items-center gap-1.5"><input type="radio" name="custmode" checked={customerMode === v} onChange={() => { setCustomerMode(v); setCustomer(null); setAddressId(''); }} /> {l}</label>
            ))}
          </div>
          {customerMode === 'new' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">{(p) => <Input {...p} value={newName} onChange={(e) => setNewName(e.target.value)} />}</Field>
              <Field label="Phone" error={phoneErr} hint="An existing customer with this number is reused.">{(p) => <Input {...p} type="tel" placeholder="0803 123 4567" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />}</Field>
            </div>
          )}
          {customerMode === 'existing' && (customer ? (
            <div className="flex items-center justify-between rounded-lg bg-sunken px-3 py-2 text-sm">
              <span><span className="font-medium">{customer.fullName}</span> <span className="text-ink-3">{customer.phone}</span></span>
              <Button size="sm" variant="ghost" onClick={() => { setCustomer(null); setAddressId(''); }}>Change</Button>
            </div>
          ) : (
            <div>
              <Input aria-label="Search customers" placeholder="Search name or phone" value={custQuery} onChange={(e) => setCustQuery(e.target.value)} />
              {matches.length > 0 && (
                <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
                  {matches.map((m) => <li key={m.id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-sunken" onClick={() => setCustomer({ id: m.id, fullName: m.fullName, phone: m.phone })}>{m.fullName} <span className="text-ink-3">{m.phone ?? m.email}</span></button></li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Card>

      {!compact && (
        <Card>
          <CardHeader title="Delivery and notes" />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {savedAddresses.length > 0 && (
              <Field label="Saved address" className="sm:col-span-2">
                {(p) => <Select {...p} value={addressId} onChange={(e) => setAddressId(e.target.value)}><option value="">Enter a new address</option>{savedAddresses.map((a) => <option key={a.id} value={a.id}>{[a.line1, a.city, a.state].join(', ')}</option>)}</Select>}
              </Field>
            )}
            {!addressId && <>
              <Field label="Address" className="sm:col-span-2" error={addressErr}>{(p) => <Input {...p} value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} />}</Field>
              <Field label="City">{(p) => <Input {...p} value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} />}</Field>
              <Field label="State">{(p) => <Input {...p} value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} />}</Field>
              <Field label="Landmark (optional)" className="sm:col-span-2">{(p) => <Input {...p} value={address.landmark} onChange={(e) => setAddress({ ...address, landmark: e.target.value })} />}</Field>
            </>}
            <Field label="Delivery fee (₦)">{(p) => <Input {...p} inputMode="decimal" value={delivery} onChange={(e) => setDelivery(e.target.value)} placeholder="0" />}</Field>
            <Field label="Order discount (₦)">{(p) => <Input {...p} inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" />}</Field>
            {!order && !liveSessionId && (
              <Field label="Sales channel" className="sm:col-span-2" hint="Defaults to “Manual / phone orders”.">
                {(p) => <Select {...p} value={channelId} onChange={(e) => setChannelId(e.target.value)}><option value="">Default</option>{channels.data?.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
              </Field>
            )}
            <Field label="Notes" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p className="mr-auto text-sm text-ink-2">Estimated total <span className="font-semibold tabular text-ink">{formatMoney(preview.total < 0n ? 0n : preview.total)}</span></p>
        {order ? (
          <Button loading={busy === 'confirm'} disabled={invalid} onClick={() => void submit(true)}>Save changes</Button>
        ) : (
          <>
            {!liveSessionId && <Button variant="secondary" loading={busy === 'draft'} disabled={invalid} onClick={() => void submit(false)}>Save as draft</Button>}
            <Button loading={busy === 'confirm'} disabled={invalid} onClick={() => void submit(true)}>{liveSessionId ? 'Record order' : 'Confirm order'}</Button>
          </>
        )}
      </div>
    </div>
  );
}
