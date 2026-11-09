import { useEffect, useState } from 'react';
import { Switch, Text } from 'react-native';
import { Badge, Button, Card, ErrorBox, Field, Loading, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { e164, isE164, money, toKobo } from '@/lib/format';

interface Settings {
  settings: { pickupEnabled: boolean; pickupAddress: string | null; pickupInstructions: string | null; deliverOutsideZones: boolean };
  zones: Array<{ id: string; name: string; states: string[]; cities: string[]; feeMinor: string; etaDays: number | null; isActive: boolean }>;
  couriers: Array<{ id: string; name: string; kind: string; phone: string | null; isActive: boolean }>;
}

/** Pickup, delivery zones and your couriers (the server prices every order from these). */
export default function DeliverySettings() {
  const { can } = useAuth();
  const res = useApi<Settings>('/delivery/settings');
  const edit = can('delivery:manage');
  const [pickup, setPickup] = useState({ on: false, address: '' });
  const [zone, setZone] = useState({ name: '', states: '', cities: '', fee: '' });
  const [courier, setCourier] = useState({ name: '', phone: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  useEffect(() => { if (res.data) setPickup({ on: res.data.settings.pickupEnabled, address: res.data.settings.pickupAddress ?? '' }); }, [res.data]);

  if (res.error) return <Screen><ErrorBox message={res.error} onRetry={res.reload} /></Screen>;
  if (!res.data) return <Loading />;
  const d = res.data;
  const fee = toKobo(zone.fee);
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const tel = courier.phone ? e164(courier.phone) : '';

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'good', text: ok });
      await res.reload();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen refreshing={res.loading} onRefresh={res.reload}>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <Card style={{ gap: 10 }}>
        <Row><Text style={{ color: c.ink, flex: 1 }}>Customers can pick up</Text><Switch value={pickup.on} disabled={!edit} onValueChange={(v) => setPickup({ ...pickup, on: v })} /></Row>
        {pickup.on ? <Field label="Pickup address" value={pickup.address} editable={edit} onChangeText={(v) => setPickup({ ...pickup, address: v })} /> : null}
        {edit ? <Button title="Save pickup" disabled={pickup.on && pickup.address.trim().length < 5} loading={busy === 'pickup'} onPress={() => void run('pickup', () => api('/delivery/settings', { method: 'PUT', body: { ...d.settings, pickupEnabled: pickup.on, pickupAddress: pickup.address.trim() || null } }), 'Pickup saved.')} /> : null}
      </Card>

      <Card style={{ gap: 8 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Delivery zones</Text>
        {d.zones.length === 0 ? <Muted>No zones yet: delivery fees are agreed with each customer.</Muted> : d.zones.map((z) => (
          <Row key={z.id}><Text style={{ color: c.ink, flex: 1 }} numberOfLines={1}>{z.name} · {[...z.cities, ...z.states].join(', ')}</Text><Text style={{ color: z.isActive ? c.ink : c.ink3 }}>{money(z.feeMinor)}</Text></Row>
        ))}
        {edit ? (
          <>
            <Field label="New zone name" value={zone.name} onChangeText={(v) => setZone({ ...zone, name: v })} placeholder="Lagos Mainland" />
            <Field label="States (comma-separated)" value={zone.states} onChangeText={(v) => setZone({ ...zone, states: v })} placeholder="Lagos" />
            <Field label="Cities (optional)" value={zone.cities} onChangeText={(v) => setZone({ ...zone, cities: v })} placeholder="Ikeja, Yaba" />
            <Field label="Fee (₦)" value={zone.fee} onChangeText={(v) => setZone({ ...zone, fee: v })} keyboardType="decimal-pad" />
            <Button variant="secondary" title="Add zone" disabled={zone.name.trim().length < 2 || !fee || list(zone.states).length + list(zone.cities).length === 0} loading={busy === 'zone'}
              onPress={() => void run('zone', async () => { await api('/delivery/zones', { method: 'POST', body: { name: zone.name.trim(), states: list(zone.states), cities: list(zone.cities), feeMinor: fee } }); setZone({ name: '', states: '', cities: '', fee: '' }); }, 'Zone added.')} />
          </>
        ) : null}
      </Card>

      <Card style={{ gap: 8 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Your couriers</Text>
        {d.couriers.length === 0 ? <Muted>Add the riders and courier companies you use.</Muted> : d.couriers.map((k) => (
          <Row key={k.id}><Text style={{ color: c.ink, flex: 1 }}>{k.name}{k.phone ? ` · ${k.phone}` : ''}</Text>{!k.isActive ? <Badge>Off</Badge> : null}</Row>
        ))}
        {edit ? (
          <>
            <Field label="Name" value={courier.name} onChangeText={(v) => setCourier({ ...courier, name: v })} placeholder="Musa (rider)" />
            <Field label="Phone (optional)" value={courier.phone} onChangeText={(v) => setCourier({ ...courier, phone: v })} keyboardType="phone-pad" error={tel && !isE164(tel) ? 'Enter a valid number' : null} />
            <Button variant="secondary" title="Add courier" disabled={courier.name.trim().length < 2 || (!!tel && !isE164(tel))} loading={busy === 'courier'}
              onPress={() => void run('courier', async () => { await api('/delivery/couriers', { method: 'POST', body: { name: courier.name.trim(), ...(tel ? { phone: tel } : {}) } }); setCourier({ name: '', phone: '' }); }, 'Courier added.')} />
          </>
        ) : null}
      </Card>
    </Screen>
  );
}
