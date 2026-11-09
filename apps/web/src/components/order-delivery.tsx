'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, ErrorState, Field, Input, PageLoading, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { DELIVERY_METHOD, DELIVERY_STATUS, deliveryActionLabel } from '@/lib/delivery-labels';
import type { DeliveryMethod, DeliverySettingsResponse, DeliveryStatus, OrderDelivery } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));

/** MASTER-SPEC §18 on the order page: method, courier, tracking reference, dispatch note and status. */
export function OrderDeliveryCard({ orderId, onChanged }: { orderId: string; onChanged: () => void }) {
  const { can } = useAuth();
  const res = useApi<OrderDelivery>(`/orders/${orderId}/delivery`);
  const setup = useApi<DeliverySettingsResponse>('/delivery/settings');
  const [courierId, setCourierId] = useState('');
  const canEdit = can('orders:update_status');
  const [f, setF] = useState({ method: 'SELLER_DELIVERY' as DeliveryMethod, carrierName: '', trackingReference: '', dispatchNote: '' });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (!res.data) return;
    const d = res.data.delivery;
    setF({ method: d?.method ?? (res.data.hasAddress ? 'SELLER_DELIVERY' : 'PICKUP'), carrierName: d?.carrierName ?? '', trackingReference: d?.trackingReference ?? '', dispatchNote: d?.dispatchNote ?? '' });
    setCourierId(d?.courierId ?? '');
  }, [res.data]);

  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (!res.data) return <Card><PageLoading /></Card>;
  const o = res.data;
  const d = o.delivery;
  if (o.orderStatus === 'DRAFT' || o.orderStatus === 'CANCELLED') return null;
  const status: DeliveryStatus = d?.status ?? 'PENDING';
  const finished = status === 'DELIVERED' || status === 'RETURNED';
  const next: DeliveryStatus[] = d ? d.nextStatuses : o.hasAddress ? ['ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'FAILED'] : ['DELIVERED', 'FAILED'];
  const couriers = (setup.data?.couriers ?? []).filter((c) => c.isActive || c.id === courierId);
  const needsCarrier = f.method === 'THIRD_PARTY' && !f.carrierName.trim() && !courierId;
  const dirty = !d || f.method !== d.method || f.carrierName !== (d.carrierName ?? '') || f.trackingReference !== (d.trackingReference ?? '') || f.dispatchNote !== (d.dispatchNote ?? '') || courierId !== (d.courierId ?? '');
  const body = () => ({
    method: f.method, trackingReference: f.trackingReference.trim() || null, dispatchNote: f.dispatchNote.trim() || null,
    ...(f.method === 'PICKUP' ? {} : courierId ? { courierId } : { courierId: null, carrierName: f.carrierName.trim() || null }),
  });

  async function save() {
    setBusy('save');
    setMsg(null);
    try {
      res.setData(await api<OrderDelivery>(`/orders/${orderId}/delivery`, { method: 'PUT', body: body() }));
      setMsg({ tone: 'good', text: 'Delivery details saved.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }
  async function move(to: DeliveryStatus) {
    if ((to === 'FAILED' || to === 'RETURNED') && !note.trim()) {
      setMsg({ tone: 'bad', text: 'Say what happened first (e.g. “Customer not reachable”).' });
      return;
    }
    setBusy(to);
    setMsg(null);
    try {
      if (dirty && !needsCarrier) await api(`/orders/${orderId}/delivery`, { method: 'PUT', body: body() });
      res.setData(await api<OrderDelivery>(`/orders/${orderId}/delivery/status`, { method: 'POST', body: { status: to, ...(note.trim() ? { note: note.trim() } : {}) } }));
      setNote('');
      setMsg({ tone: 'good', text: to === 'IN_TRANSIT' ? 'Marked on the way. The customer is told, with the courier and tracking number.' : to === 'DELIVERED' ? 'Marked delivered.' : 'Recorded.' });
      onChanged();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader title="Delivery" description={d?.zone ? `Zone: ${d.zone.name}${d.zone.etaDays !== null ? ` · usually ${d.zone.etaDays} day(s)` : ''}` : undefined}
        action={<Badge tone={DELIVERY_STATUS[status].tone}>{f.method === 'PICKUP' && status === 'DELIVERED' ? 'Collected' : DELIVERY_STATUS[status].label}</Badge>} />
      <div className="space-y-4 p-5 text-sm">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {d?.problemNote && (status === 'FAILED' || status === 'RETURNED') && <Alert tone="warn">{d.problemNote}</Alert>}
        <fieldset disabled={!canEdit || finished} className="grid gap-3 sm:grid-cols-2">
          <Field label="How it reaches the customer">{(p) => (
            <Select {...p} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as DeliveryMethod })}>
              {(Object.keys(DELIVERY_METHOD) as DeliveryMethod[]).filter((m) => m === 'PICKUP' || o.hasAddress).map((m) => <option key={m} value={m}>{DELIVERY_METHOD[m]}</option>)}
            </Select>
          )}</Field>
          {f.method !== 'PICKUP' && couriers.length > 0 && <Field label="Your courier" hint="Add riders and courier companies in Settings → Delivery">{(p) => (
            <Select {...p} value={courierId} onChange={(e) => { setCourierId(e.target.value); const c = couriers.find((x) => x.id === e.target.value); if (c) setF({ ...f, carrierName: c.name, method: c.kind === 'COMPANY' ? 'THIRD_PARTY' : f.method }); }}>
              <option value="">Someone else (type a name)</option>
              {couriers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.kind === 'COMPANY' ? ' (company)' : ''}{c.isActive ? '' : ' — switched off'}</option>)}
            </Select>
          )}</Field>}
          {f.method !== 'PICKUP' && !courierId && <Field label={f.method === 'THIRD_PARTY' ? 'Courier' : 'Rider or carrier (optional)'} error={needsCarrier ? 'Name the courier' : undefined}>{(p) => <Input {...p} maxLength={80} value={f.carrierName} onChange={(e) => setF({ ...f, carrierName: e.target.value })} placeholder={f.method === 'THIRD_PARTY' ? 'Speedy Couriers' : 'Musa (rider)'} />}</Field>}
          {f.method !== 'PICKUP' && <Field label="Tracking or waybill number (optional)">{(p) => <Input {...p} maxLength={80} value={f.trackingReference} onChange={(e) => setF({ ...f, trackingReference: e.target.value })} />}</Field>}
          <Field label="Note for the customer (optional)" className={f.method === 'PICKUP' ? '' : 'sm:col-span-1'}>{(p) => <Input {...p} maxLength={300} value={f.dispatchNote} onChange={(e) => setF({ ...f, dispatchNote: e.target.value })} placeholder="Rider will call before arriving" />}</Field>
        </fieldset>
        {canEdit && !finished && dirty && <Button size="sm" variant="secondary" loading={busy === 'save'} disabled={needsCarrier} onClick={() => void save()}>Save details</Button>}

        {(d?.dispatchedAt || d?.deliveredAt) && <p className="text-[13px] text-ink-3">{d.dispatchedAt ? `Sent ${when(d.dispatchedAt)}` : ''}{d.dispatchedAt && d.deliveredAt ? ' · ' : ''}{d.deliveredAt ? `${f.method === 'PICKUP' ? 'Collected' : 'Delivered'} ${when(d.deliveredAt)}` : ''}</p>}

        {canEdit && !finished && (
          o.shippable ? (
            <div className="space-y-2 rounded-lg border border-line p-3">
              <Field label="What happened (needed for a failed attempt or a return)">{(p) => <Input {...p} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Customer not reachable; retry tomorrow" />}</Field>
              <div className="flex flex-wrap gap-2">
                {next.map((s) => (
                  <Button key={s} size="sm" variant={s === 'DELIVERED' || s === 'IN_TRANSIT' ? 'primary' : 'secondary'} loading={busy === s} disabled={needsCarrier && s === 'IN_TRANSIT'} onClick={() => void move(s)}>{deliveryActionLabel(s, f.method)}</Button>
                ))}
              </div>
            </div>
          ) : <p className="text-[13px] text-ink-3">Delivery starts once the payment is verified.</p>
        )}
      </div>
    </Card>
  );
}
