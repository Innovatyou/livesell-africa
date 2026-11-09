'use client';

import { useEffect, useState } from 'react';
import { CouriersCard } from '@/components/couriers-card';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageLoading, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { splitList } from '@/lib/delivery-labels';
import { formatMoney, koboToNairaInput, nairaToKobo } from '@/lib/money';
import type { DeliverySettings, DeliverySettingsResponse, DeliveryZone } from '@/lib/types';
import { useApi } from '@/lib/use-api';

/** MASTER-SPEC §18: delivery zones and fees, pickup, out-of-zone policy. The server prices every order from these. */
export default function DeliverySettingsPage() {
  const { can } = useAuth();
  const res = useApi<DeliverySettingsResponse>(can('orders:read') ? '/delivery/settings' : null);
  const edit = can('delivery:manage');
  if (!can('orders:read')) return <Card><EmptyState title="Your role can’t view delivery settings" /></Card>;
  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (!res.data) return <PageLoading />;
  const d = res.data;
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Delivery" description="Customers see the fee for their area at checkout and on WhatsApp. You can still set a fee by hand on orders you enter yourself." />
      {!edit && <Alert tone="info">You can view these settings. Changing them needs the “Manage delivery zones and dispatch” permission.</Alert>}
      <PickupCard s={d.settings} canEdit={edit} onSaved={(x) => res.setData(x)} />
      <ZonesCard zones={d.zones} canEdit={edit} onChanged={() => void res.reload()} />
      <CouriersCard couriers={d.couriers} canEdit={edit} onChanged={() => void res.reload()} />
      <Card>
        <CardHeader title="Logistics integrations" description="For now you deliver with your own riders and the courier companies you book yourself (above). Courier APIs plug in here later." />
        <ul className="divide-y divide-line">
          {d.providers.map((p) => <li key={p.code} className="flex items-center justify-between px-5 py-3 text-sm"><span>{p.name}</span><Badge>{p.capabilities.booking ? 'Booking' : 'Manual updates'}</Badge></li>)}
        </ul>
      </Card>
    </div>
  );
}

function PickupCard({ s, canEdit, onSaved }: { s: DeliverySettings; canEdit: boolean; onSaved: (x: DeliverySettingsResponse) => void }) {
  const [f, setF] = useState(s);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  useEffect(() => setF(s), [s]);
  const addressMissing = f.pickupEnabled && !(f.pickupAddress ?? '').trim();
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      onSaved(await api<DeliverySettingsResponse>('/delivery/settings', { method: 'PUT', body: { ...f, pickupAddress: f.pickupAddress?.trim() || null, pickupInstructions: f.pickupInstructions?.trim() || null } }));
      setMsg({ tone: 'good', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader title="Pickup and coverage" />
      <fieldset disabled={!canEdit} className="space-y-4 p-5">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={f.pickupEnabled} onChange={(e) => setF({ ...f, pickupEnabled: e.target.checked })} /> Customers can pick up their order</label>
        {f.pickupEnabled && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Pickup address" error={addressMissing ? 'Add the address customers should come to' : undefined}>{(p) => <Input {...p} maxLength={300} value={f.pickupAddress ?? ''} onChange={(e) => setF({ ...f, pickupAddress: e.target.value })} placeholder="Shop 12, Computer Village, Ikeja" />}</Field>
          <Field label="Pickup hours or instructions (optional)">{(p) => <Input {...p} maxLength={300} value={f.pickupInstructions ?? ''} onChange={(e) => setF({ ...f, pickupInstructions: e.target.value })} placeholder="Mon–Sat, 10am–6pm. Call on arrival." />}</Field>
        </div>}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={f.deliverOutsideZones} onChange={(e) => setF({ ...f, deliverOutsideZones: e.target.checked })} />
          <span><span className="font-medium">Accept orders to places no zone covers</span><span className="block text-ink-3">The order goes in without a delivery fee and you agree the fee with the customer. Untick to accept only addresses inside your zones (pickup still works).</span></span></label>
        {canEdit && <Button loading={busy} disabled={addressMissing} onClick={() => void save()}>Save</Button>}
      </fieldset>
    </Card>
  );
}

const blank = { name: '', states: '', cities: '', fee: '', eta: '' };

function ZonesCard({ zones, canEdit, onChanged }: { zones: DeliveryZone[]; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const fee = nairaToKobo(f.fee);
  const eta = f.eta.trim() === '' ? null : /^\d{1,2}$/.test(f.eta.trim()) && Number(f.eta) <= 60 ? Number(f.eta) : NaN;
  const covers = splitList(f.states).length + splitList(f.cities).length > 0;
  const valid = f.name.trim().length >= 2 && fee !== null && !Number.isNaN(eta) && covers;

  function open(z: DeliveryZone | null) {
    setMsg(null);
    setEditing(z ? z.id : 'new');
    setF(z ? { name: z.name, states: z.states.join(', '), cities: z.cities.join(', '), fee: koboToNairaInput(z.feeMinor), eta: z.etaDays === null ? '' : String(z.etaDays) } : blank);
  }
  async function save() {
    setBusy('save');
    setMsg(null);
    const body = { name: f.name.trim(), states: splitList(f.states), cities: splitList(f.cities), feeMinor: fee, etaDays: eta };
    try {
      if (editing === 'new') await api('/delivery/zones', { method: 'POST', body });
      else await api(`/delivery/zones/${editing}`, { method: 'PATCH', body });
      setEditing(null);
      setMsg({ tone: 'good', text: 'Zone saved.' });
      onChanged();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }
  async function toggle(z: DeliveryZone) {
    setBusy(z.id);
    try {
      await api(`/delivery/zones/${z.id}`, { method: 'PATCH', body: { isActive: !z.isActive } });
      onChanged();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }
  async function remove(z: DeliveryZone) {
    if (!window.confirm(`Remove the zone “${z.name}”?`)) return;
    setBusy(z.id);
    try {
      const r = await api<{ archived: boolean }>(`/delivery/zones/${z.id}`, { method: 'DELETE' });
      setMsg({ tone: 'good', text: r.archived ? 'Past orders used this zone, so it was switched off instead of deleted.' : 'Zone removed.' });
      onChanged();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader title="Delivery zones" description="A zone that lists cities applies only to those cities; one with states only covers the whole state. When zones overlap, the city zone wins, then the cheaper one."
        action={canEdit && editing === null && <Button size="sm" onClick={() => open(null)}>Add zone</Button>} />
      {msg && <div className="px-5 pt-4"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {editing !== null && (
        <div className="space-y-3 border-b border-line p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Zone name">{(p) => <Input {...p} maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Lagos Mainland" />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Fee (₦)" error={f.fee && fee === null ? 'Enter an amount' : undefined}>{(p) => <Input {...p} inputMode="decimal" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} placeholder="2,500" />}</Field>
              <Field label="Days (optional)" error={Number.isNaN(eta) ? '0–60' : undefined}>{(p) => <Input {...p} inputMode="numeric" value={f.eta} onChange={(e) => setF({ ...f, eta: e.target.value })} placeholder="2" />}</Field>
            </div>
            <Field label="States" hint="Comma-separated, e.g. Lagos, Ogun">{(p) => <Textarea {...p} rows={2} value={f.states} onChange={(e) => setF({ ...f, states: e.target.value })} />}</Field>
            <Field label="Cities or areas (optional)" hint="Limits the zone to these, e.g. Ikeja, Yaba" error={!covers && (f.states || f.cities) === '' && f.name ? 'Name at least one state or city' : undefined}>{(p) => <Textarea {...p} rows={2} value={f.cities} onChange={(e) => setF({ ...f, cities: e.target.value })} />}</Field>
          </div>
          <div className="flex gap-2">
            <Button loading={busy === 'save'} disabled={!valid} onClick={() => void save()}>{editing === 'new' ? 'Add zone' : 'Save zone'}</Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {zones.length === 0 ? (
        <EmptyState title="No delivery zones yet">Without zones, orders go in without a delivery fee and you agree it with the customer.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {zones.map((z) => (
            <li key={z.id} className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium">{z.name} {!z.isActive && <Badge>Off</Badge>}</p>
                <p className="text-[13px] text-ink-3">{[z.cities.length ? z.cities.join(', ') : null, z.states.join(', ')].filter(Boolean).join(' · ')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="tabular font-medium">{formatMoney(z.feeMinor, z.currency)}</span>
                {z.etaDays !== null && <span className="text-[13px] text-ink-3">{z.etaDays} day{z.etaDays === 1 ? '' : 's'}</span>}
                {canEdit && <>
                  <Button size="sm" variant="secondary" onClick={() => open(z)}>Edit</Button>
                  <Button size="sm" variant="secondary" loading={busy === z.id} onClick={() => void toggle(z)}>{z.isActive ? 'Switch off' : 'Switch on'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(z)}>Remove</Button>
                </>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
