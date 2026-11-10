import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Badge, Button, Card, ErrorBox, Field, Loading, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { e164, isE164, money } from '@/lib/format';
import { discard, enqueue, flush, list as listQueue, newClientRef, retryable, type QueuedOrder } from '@/lib/offline-queue';
import { useTheme } from '@/lib/theme';

interface Session {
  id: string; title: string; status: string; orderInstructions: string | null; channel: { name: string };
  products: Array<{ sessionPriceMinor: string | null; product: { id: string; name: string; productCode: string; variants: Array<{ id: string; sku: string; name: string; priceMinor: string; available: number }> } }>;
}
interface VariantChoice { sku: string; name: string }

/**
 * Live console: start / end the session and record orders as viewers comment product codes (the default ordering
 * method, MASTER-SPEC §9). Prices come from the server; stock is reserved the moment the order is saved.
 */
export default function LiveConsole() {
  useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can, workspace } = useAuth();
  const res = useApi<Session>(`/live-sessions/${id}`);
  const [queue, setQueue] = useState<QueuedOrder[]>([]);
  const refreshQueue = useCallback(async () => setQueue((await listQueue()).filter((x) => x.tenantId === workspace?.id && x.body.liveSessionId === id)), [workspace?.id, id]);
  useEffect(() => {
    void refreshQueue();
    // While orders wait, keep trying every 20 s (the API never creates the same order twice).
    const t = setInterval(() => { void flush(workspace?.id ?? null).then(refreshQueue); }, 20_000);
    return () => clearInterval(t);
  }, [refreshQueue, workspace?.id]);
  const [code, setCode] = useState('');
  const [qty, setQty] = useState('1');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [choices, setChoices] = useState<VariantChoice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string; orderId?: string } | null>(null);

  if (res.error) return <Screen><ErrorBox message={res.error} onRetry={res.reload} /></Screen>;
  if (!res.data) return <Loading />;
  const s = res.data;
  const live = s.status === 'LIVE';
  const tel = e164(phone);
  const q = Number(qty);
  const valid = code.trim().length >= 2 && Number.isInteger(q) && q >= 1 && q <= 100 && name.trim().length >= 2 && isE164(tel);

  async function move(action: 'start' | 'end') {
    setBusy(action);
    setMsg(null);
    try {
      await api(`/live-sessions/${id}/${action}`, { method: 'POST', body: action === 'end' ? {} : undefined });
      await res.reload();
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const clearForm = () => { setChoices(null); setCode(''); setQty('1'); setName(''); setPhone(''); };

  async function record(variantSku?: string) {
    setBusy('order');
    setMsg(null);
    const body = { liveSessionId: id, clientRef: newClientRef(), customer: { fullName: name.trim(), phone: tel }, items: [{ productCode: code.trim().toUpperCase(), quantity: q, ...(variantSku ? { variantSku } : {}) }] };
    try {
      const o = await api<{ id: string; reference: string; totalMinor: string; currency: string }>('/orders', { method: 'POST', body });
      setMsg({ tone: 'good', text: `${o.reference} saved · ${money(o.totalMinor, o.currency)}. Stock is held while they pay.`, orderId: o.id });
      clearForm();
    } catch (e) {
      const err = e as ApiError;
      const info = err.body as { code?: string; variants?: VariantChoice[] } | undefined;
      if (retryable(err)) {
        // No connection: keep the order on the phone and send it as soon as possible.
        await enqueue(workspace!.id, body, `${q} x ${body.items[0].productCode} - ${name.trim()}`);
        await refreshQueue();
        clearForm();
        setMsg({ tone: 'good', text: 'No connection: order saved on this phone. It will be sent automatically.' });
      } else if (info?.code === 'VARIANT_REQUIRED' && info.variants) setChoices(info.variants);
      else setMsg({ tone: 'bad', text: err.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen refreshing={res.loading} onRefresh={res.reload}>
      <Card style={{ gap: 6 }}>
        <Row><Text style={{ fontSize: 18, fontWeight: '700', color: c.ink, flex: 1 }}>{s.title}</Text><Badge tone={live ? 'bad' : 'neutral'}>{live ? '● Live' : s.status.toLowerCase()}</Badge></Row>
        <Muted>{s.channel.name}{s.orderInstructions ? ` · ${s.orderInstructions}` : ''}</Muted>
        {can('live:manage') && s.status === 'SCHEDULED' ? <Button title="Go live" loading={busy === 'start'} onPress={() => void move('start')} /> : null}
        {can('live:manage') && live ? <Button variant="danger" title="End live" loading={busy === 'end'} onPress={() => void move('end')} /> : null}
      </Card>

      {msg ? (
        <Pressable onPress={() => msg.orderId && router.push(`/orders/${msg.orderId}`)}>
          <Notice tone={msg.tone}>{msg.text}{msg.orderId ? '  Tap to open.' : ''}</Notice>
        </Pressable>
      ) : null}

      {queue.length > 0 ? (
        <Card style={{ gap: 6 }}>
          <Text style={{ fontWeight: '700', color: c.ink }}>{queue.length} order{queue.length === 1 ? '' : 's'} waiting to send</Text>
          {queue.map((x) => (
            <Row key={x.clientRef}>
              <Text style={{ color: x.failed ? c.bad : c.ink, flex: 1 }} numberOfLines={2}>{x.label}{x.failed ? ` (${x.failed})` : ''}</Text>
              {x.failed ? <Text style={{ color: c.bad }} onPress={() => void discard(x.clientRef).then(refreshQueue)}>Discard</Text> : <Muted>waiting</Muted>}
            </Row>
          ))}
          <Button variant="secondary" title="Send now" loading={busy === 'flush'} onPress={() => { setBusy('flush'); void flush(workspace?.id ?? null).then(async (r) => { await refreshQueue(); setBusy(null); setMsg(r.sent ? { tone: 'good', text: `${r.sent} order(s) sent.` } : r.left ? { tone: 'bad', text: 'Still offline. Will keep trying.' } : null); }); }} />
        </Card>
      ) : null}

      {live && can('orders:create') ? (
        <Card style={{ gap: 10 }}>
          <Text style={{ fontWeight: '700', color: c.ink }}>Record an order</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 2 }}><Field label="Product code" value={code} onChangeText={(v) => { setCode(v); setChoices(null); }} autoCapitalize="characters" placeholder="BAG001" /></View>
            <View style={{ flex: 1 }}><Field label="Qty" value={qty} onChangeText={setQty} keyboardType="number-pad" /></View>
          </View>
          <Field label="Customer name" value={name} onChangeText={setName} placeholder="As in the comments" />
          <Field label="Customer phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="0803 123 4567" error={phone && !isE164(tel) ? 'Enter a valid phone number' : null} />
          {choices ? (
            <View style={{ gap: 6 }}>
              <Muted>Which one?</Muted>
              {choices.map((v) => <Button key={v.sku} variant="secondary" title={v.name} loading={busy === 'order'} onPress={() => void record(v.sku)} />)}
            </View>
          ) : <Button title="Save order" disabled={!valid} loading={busy === 'order'} onPress={() => void record()} />}
        </Card>
      ) : null}

      <Card style={{ gap: 6 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Products in this live</Text>
        {s.products.length === 0 ? <Muted>Any product code from your catalogue works.</Muted> : s.products.map((p) => {
          const left = p.product.variants.reduce((n, v) => n + v.available, 0);
          return (
            <Pressable key={p.product.id} onPress={() => { setCode(p.product.productCode); setChoices(null); }}>
              <Row><Text style={{ color: c.ink, flex: 1 }} numberOfLines={1}>{p.product.productCode} · {p.product.name}</Text><Muted>{left > 0 ? `${left} left` : 'sold out'}</Muted></Row>
            </Pressable>
          );
        })}
      </Card>
    </Screen>
  );
}
