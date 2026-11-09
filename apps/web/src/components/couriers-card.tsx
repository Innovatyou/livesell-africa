'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { E164, normalisePhone } from '@/lib/nav';
import type { Courier } from '@/lib/types';

const blank = { name: '', kind: 'RIDER' as Courier['kind'], phone: '', notes: '', showPhoneToCustomer: false };

/** The seller's own riders and the courier companies they book themselves (MASTER-SPEC §18, starting with private couriers). */
export function CouriersCard({ couriers, canEdit, onChanged }: { couriers: Courier[]; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const phone = f.phone.trim() ? normalisePhone(f.phone) : '';
  const phoneOk = !phone || E164.test(phone);
  const valid = f.name.trim().length >= 2 && phoneOk && (!f.showPhoneToCustomer || !!phone);

  function open(c: Courier | null) {
    setMsg(null);
    setEditing(c ? c.id : 'new');
    setF(c ? { name: c.name, kind: c.kind, phone: c.phone ?? '', notes: c.notes ?? '', showPhoneToCustomer: c.showPhoneToCustomer } : blank);
  }
  async function save() {
    setBusy('save');
    setMsg(null);
    const body = { name: f.name.trim(), kind: f.kind, phone: phone || null, notes: f.notes.trim() || null, showPhoneToCustomer: f.showPhoneToCustomer };
    try {
      if (editing === 'new') await api('/delivery/couriers', { method: 'POST', body });
      else await api(`/delivery/couriers/${editing}`, { method: 'PATCH', body });
      setEditing(null);
      setMsg({ tone: 'good', text: 'Courier saved.' });
      onChanged();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }
  async function toggle(c: Courier) {
    setBusy(c.id);
    try {
      await api(`/delivery/couriers/${c.id}`, { method: 'PATCH', body: { isActive: !c.isActive } });
      onChanged();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }
  async function remove(c: Courier) {
    if (!window.confirm(`Remove ${c.name}?`)) return;
    setBusy(c.id);
    try {
      const r = await api<{ archived: boolean }>(`/delivery/couriers/${c.id}`, { method: 'DELETE' });
      setMsg({ tone: 'good', text: r.archived ? `${c.name} carried past orders, so they were switched off instead of deleted.` : 'Courier removed.' });
      onChanged();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader title="Your couriers" description="Riders on your team and courier companies you book yourself. Pick one on an order and its name goes into the customer’s dispatch message and tracking page."
        action={canEdit && editing === null && <Button size="sm" onClick={() => open(null)}>Add courier</Button>} />
      {msg && <div className="px-5 pt-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {editing !== null && (
        <div className="space-y-3 border-b border-line p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">{(p) => <Input {...p} maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Musa (rider) or Speedy Couriers" />}</Field>
            <Field label="Type">{(p) => <Select {...p} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Courier['kind'] })}><option value="RIDER">Our rider</option><option value="COMPANY">Courier company</option></Select>}</Field>
            <Field label="Phone (optional)" error={phoneOk ? undefined : 'Enter a valid phone number'}>{(p) => <Input {...p} type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="0803 123 4567" />}</Field>
            <Field label="Notes (optional)">{(p) => <Input {...p} maxLength={300} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Covers Lekki and VI" />}</Field>
          </div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={f.showPhoneToCustomer} onChange={(e) => setF({ ...f, showPhoneToCustomer: e.target.checked })} />
            <span>Show this phone number to customers while their order is on its way{f.showPhoneToCustomer && !phone ? <span className="block text-bad">Add the phone number first.</span> : null}</span></label>
          <div className="flex gap-2">
            <Button loading={busy === 'save'} disabled={!valid} onClick={() => void save()}>{editing === 'new' ? 'Add courier' : 'Save courier'}</Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {couriers.length === 0 ? <EmptyState title="No couriers yet">You can still type a rider or courier name on each order.</EmptyState> : (
        <ul className="divide-y divide-line">
          {couriers.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium">{c.name} <Badge>{c.kind === 'COMPANY' ? 'Company' : 'Rider'}</Badge> {!c.isActive && <Badge>Off</Badge>}</p>
                <p className="text-[13px] text-ink-3">{[c.phone, c.showPhoneToCustomer ? 'phone shown to customers' : null, c.notes, c._count ? `${c._count.deliveries} deliveries` : null].filter(Boolean).join(' · ')}</p>
              </div>
              {canEdit && <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="secondary" onClick={() => open(c)}>Edit</Button>
                <Button size="sm" variant="secondary" loading={busy === c.id} onClick={() => void toggle(c)}>{c.isActive ? 'Switch off' : 'Switch on'}</Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(c)}>Remove</Button>
              </div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
