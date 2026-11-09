'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Dialog } from '@/components/dialog';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageLoading, Textarea } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money';
import { E164, normalisePhone } from '@/lib/nav';
import type { Address, Customer } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const date = (s: string | null) => (s ? new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(s)) : '—');

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useAuth();
  const canWrite = can('customers:write');
  const c = useApi<Customer>(`/customers/${id}`);
  const [f, setF] = useState({ fullName: '', phone: '', email: '', tags: '', notes: '', whatsappOptIn: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [address, setAddress] = useState<Partial<Address> | null>(null);

  useEffect(() => {
    if (c.data) setF({ fullName: c.data.fullName, phone: c.data.phone ?? '', email: c.data.email ?? '', tags: c.data.tags.join(', '), notes: c.data.notes ?? '', whatsappOptIn: c.data.whatsappOptIn });
  }, [c.data]);

  if (c.error) return <ErrorState message={c.error} onRetry={c.reload} />;
  if (!c.data) return <PageLoading />;
  const d = c.data;
  const erased = !!d.anonymizedAt;
  const phoneErr = f.phone && !E164.test(normalisePhone(f.phone)) ? 'Enter a valid phone number' : null;

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'good', text: ok });
      await c.reload();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }
  const save = () => run('save', () => api(`/customers/${id}`, {
    method: 'PATCH',
    body: {
      fullName: f.fullName.trim(), phone: f.phone ? normalisePhone(f.phone) : null, email: f.email.trim() || null, notes: f.notes,
      tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), whatsappOptIn: f.whatsappOptIn,
    },
  }), 'Customer saved.');

  async function remove() {
    if (!window.confirm(`Delete ${d.fullName}? This can't be undone.`)) return;
    try {
      await api(`/customers/${id}`, { method: 'DELETE' });
      router.replace('/customers');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'HAS_ORDERS') setMsg({ tone: 'bad', text: `${e.message} Use “Erase personal data” instead.` });
      else setMsg({ tone: 'bad', text: errorMessage(e) });
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="mb-2 text-sm"><Link href="/customers" className="text-ink-3 hover:text-ink">← Customers</Link></p>
        <PageHeader title={d.fullName} description={<span className="flex flex-wrap gap-1">
          {erased && <Badge>Personal data erased {date(d.anonymizedAt)}</Badge>}{d.stats.vip && <Badge tone="brand">Top spender</Badge>}
          {d.stats.repeat && <Badge tone="good">Repeat customer</Badge>}<span className="text-ink-3">Customer since {date(d.createdAt)}</span></span>} />
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <section aria-label="Stats" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['Total spent', formatMoney(d.stats.totalSpentMinor)], ['Orders', String(d.stats.orderCount)], ['Open orders', String(d.stats.outstanding)], ['Last order', date(d.stats.lastOrderAt)]].map(([l, v]) => (
          <Card key={l} className="p-4"><p className="text-[13px] text-ink-3">{l}</p><p className="mt-1 text-lg font-semibold tabular">{v}</p></Card>
        ))}
      </section>

      <Card>
        <CardHeader title="Profile" />
        <fieldset disabled={!canWrite || erased || !!busy} className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Full name">{(p) => <Input {...p} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />}</Field>
          <Field label="Phone" error={phoneErr}>{(p) => <Input {...p} type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
          <Field label="Email">{(p) => <Input {...p} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
          <Field label="Tags" hint="Comma separated">{(p) => <Input {...p} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />}</Field>
          <Field label="Notes" hint="Only your team sees these" className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} maxLength={2000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
          <label className="flex items-start gap-2 text-sm text-ink-2 sm:col-span-2">
            <input type="checkbox" className="mt-0.5" checked={f.whatsappOptIn} onChange={(e) => setF({ ...f, whatsappOptIn: e.target.checked })} />
            <span>Agreed to WhatsApp messages{d.optInAt ? ` (since ${date(d.optInAt)})` : ''}</span>
          </label>
          {canWrite && !erased && <div className="sm:col-span-2"><Button loading={busy === 'save'} disabled={f.fullName.trim().length < 2 || !!phoneErr || (!f.phone && !f.email)} onClick={() => void save()}>Save changes</Button></div>}
        </fieldset>
      </Card>

      <Card>
        <CardHeader title="Addresses" action={canWrite && !erased && <Button size="sm" variant="secondary" onClick={() => setAddress({})}>Add address</Button>} />
        {d.addresses.length === 0 ? <EmptyState title="No saved addresses" /> : (
          <ul className="divide-y divide-line">
            {d.addresses.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <p className="font-medium">{a.label ?? 'Address'} {a.isDefault && <Badge tone="brand">Default</Badge>}</p>
                  <p className="text-ink-2">{[a.line1, a.line2, a.city, a.state].filter(Boolean).join(', ')}{a.landmark ? ` · ${a.landmark}` : ''}</p>
                </div>
                {canWrite && !erased && <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setAddress(a)}>Edit</Button>
                  <Button size="sm" variant="ghost" loading={busy === `del-${a.id}`} onClick={() => void run(`del-${a.id}`, () => api(`/customers/${id}/addresses/${a.id}`, { method: 'DELETE' }), 'Address removed.')}>Remove</Button>
                </div>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Orders" />
        {d.orders.length === 0 ? <EmptyState title="No orders yet">Orders this customer places will be listed here.</EmptyState> : (
          <ul className="divide-y divide-line">
            {d.orders.map((o) => (
              <li key={o.id} className="flex items-center justify-between px-5 py-3 text-sm">
                <span><Link href={`/orders/${o.id}`} className="font-mono hover:text-brand-700">{o.reference}</Link> <span className="text-ink-3">· {date(o.createdAt)}</span></span>
                <span className="flex items-center gap-3"><Badge>{o.status.replace(/_/g, ' ').toLowerCase()}</Badge><span className="tabular">{formatMoney(o.totalMinor, o.currency)}</span></span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canWrite && !erased && (
        <Card>
          <CardHeader title="Privacy" description="Customers can ask you to delete their personal data." />
          <div className="flex flex-wrap gap-2 p-5">
            <Button variant="danger" loading={busy === 'erase'} onClick={() => { if (window.confirm(`Erase ${d.fullName}'s personal data? Name, contact details, notes and addresses are removed; order amounts stay for your records. This can't be undone.`)) void run('erase', () => api(`/customers/${id}/anonymise`, { method: 'POST', body: {} }), 'Personal data erased.'); }}>Erase personal data</Button>
            <Button variant="ghost" onClick={() => void remove()}>Delete customer</Button>
          </div>
        </Card>
      )}

      {address && <AddressDialog customerId={id} address={address} onClose={() => setAddress(null)} onDone={(text) => { setAddress(null); setMsg({ tone: 'good', text }); void c.reload(); }} />}
    </div>
  );
}

function AddressDialog({ customerId, address, onClose, onDone }: { customerId: string; address: Partial<Address>; onClose: () => void; onDone: (msg: string) => void }) {
  const [f, setF] = useState({ label: address.label ?? '', line1: address.line1 ?? '', line2: address.line2 ?? '', city: address.city ?? '', state: address.state ?? '', landmark: address.landmark ?? '', isDefault: address.isDefault ?? false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = f.line1.trim().length >= 3 && f.city.trim().length >= 2 && f.state.trim().length >= 2;
  async function save() {
    setBusy(true);
    setError(null);
    const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '').map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    try {
      if (address.id) await api(`/customers/${customerId}/addresses/${address.id}`, { method: 'PATCH', body });
      else await api(`/customers/${customerId}/addresses`, { method: 'POST', body });
      onDone(address.id ? 'Address updated.' : 'Address added.');
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={address.id ? 'Edit address' : 'Add address'} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!valid} onClick={() => void save()}>Save</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="bad">{error}</Alert>}
        <Field label="Label (optional)">{(p) => <Input {...p} placeholder="Home, Office" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />}</Field>
        <Field label="Address">{(p) => <Input {...p} value={f.line1} onChange={(e) => setF({ ...f, line1: e.target.value })} />}</Field>
        <Field label="Address line 2 (optional)">{(p) => <Input {...p} value={f.line2} onChange={(e) => setF({ ...f, line2: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City">{(p) => <Input {...p} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />}</Field>
          <Field label="State">{(p) => <Input {...p} value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })} />}</Field>
        </div>
        <Field label="Landmark (optional)">{(p) => <Input {...p} placeholder="Opposite Shoprite" value={f.landmark} onChange={(e) => setF({ ...f, landmark: e.target.value })} />}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} /> Default delivery address</label>
      </div>
    </Dialog>
  );
}
