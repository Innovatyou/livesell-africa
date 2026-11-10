import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { Badge, Button, Card, ErrorBox, Field, Loading, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { ACTION_LABEL, holdLabel, money, ORDER_STATUS, toKobo, when } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Txn { id: string; provider: string; status: string; grossMinor: string; currency: string; transferEvidence: { payerName?: string; payerBank?: string; payerReference?: string } | null; createdAt: string }
interface Order {
  id: string; reference: string; status: string; currency: string; subtotalMinor: string; deliveryFeeMinor: string; totalMinor: string; reservationExpiresAt: string | null; createdAt: string;
  items: Array<{ id: string; productName: string; productCode: string | null; variantName: string; quantity: number; backorderedQty?: number; lineTotalMinor: string }>;
  customer: { fullName: string; phone: string | null } | null; shippingAddress: { line1: string; city: string; state: string } | null;
  transactions: Txn[]; nextStatuses: string[];
}

/** One order: items, customer, payment and the next steps — the same rules as the web (the API enforces them). */
export default function OrderScreen() {
  useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can } = useAuth();
  const res = useApi<Order>(`/orders/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [amount, setAmount] = useState('');

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

  if (res.error) return <Screen><ErrorBox message={res.error} onRetry={res.reload} /></Screen>;
  if (!res.data) return <Loading />;
  const o = res.data;
  const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: 'neutral' as const };
  const claim = o.transactions.find((t) => t.provider === 'BANK_TRANSFER' && t.status === 'PENDING');
  const kobo = toKobo(amount);

  return (
    <Screen refreshing={res.loading} onRefresh={res.reload}>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <Card style={{ gap: 6 }}>
        <Row><Text style={{ fontSize: 20, fontWeight: '700', color: c.ink }}>{o.reference}</Text><Badge tone={st.tone}>{st.label}</Badge></Row>
        <Muted>{when(o.createdAt)}{['PENDING_PAYMENT', 'PAYMENT_VERIFICATION'].includes(o.status) && o.reservationExpiresAt ? ` · ${holdLabel(o.reservationExpiresAt)}` : ''}</Muted>
        {o.items.map((i) => (
          <Row key={i.id}><Text style={{ color: c.ink, flex: 1 }}>{i.quantity} × {i.productCode ? `${i.productCode} ` : ''}{i.productName}{i.variantName !== 'Default' ? ` (${i.variantName})` : ''}{i.backorderedQty ? `\nPre-order: ${i.backorderedQty} awaiting stock` : ''}</Text><Text style={{ color: c.ink }}>{money(i.lineTotalMinor, o.currency)}</Text></Row>
        ))}
        {o.deliveryFeeMinor !== '0' ? <Row><Muted>Delivery</Muted><Muted>{money(o.deliveryFeeMinor, o.currency)}</Muted></Row> : null}
        <Row><Text style={{ fontWeight: '700', color: c.ink }}>Total</Text><Text style={{ fontWeight: '700', color: c.ink }}>{money(o.totalMinor, o.currency)}</Text></Row>
      </Card>

      {o.customer ? (
        <Card style={{ gap: 6 }}>
          <Text style={{ fontWeight: '700', color: c.ink }}>{o.customer.fullName}</Text>
          {o.shippingAddress ? <Muted>{o.shippingAddress.line1}, {o.shippingAddress.city}, {o.shippingAddress.state}</Muted> : <Muted>Pickup</Muted>}
          {o.customer.phone ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}><Button variant="secondary" title="Call" onPress={() => void Linking.openURL(`tel:${o.customer!.phone}`)} /></View>
              <View style={{ flex: 1 }}><Button variant="secondary" title="WhatsApp" onPress={() => void Linking.openURL(`https://wa.me/${o.customer!.phone!.replace(/\D/g, '')}`)} /></View>
            </View>
          ) : null}
        </Card>
      ) : null}

      {claim && can('payments:verify_transfer') ? (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontWeight: '700', color: c.ink }}>Bank transfer to check</Text>
          <Muted>{[claim.transferEvidence?.payerName, claim.transferEvidence?.payerBank, claim.transferEvidence?.payerReference].filter(Boolean).join(' · ')}</Muted>
          <Muted>Check your bank app. Mark it paid only when the money is really there.</Muted>
          <Field label="Amount you received (₦)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={money(o.totalMinor, o.currency)} error={amount && !kobo ? 'Enter an amount, e.g. 25,000' : null} />
          <Button title="Confirm payment received" disabled={!kobo} loading={busy === 'verify'}
            onPress={() => void run('verify', () => api(`/orders/${o.id}/transfers/${claim.id}/verify`, { method: 'POST', body: { amountReceivedMinor: kobo } }), 'Payment confirmed. The order is paid.')} />
          <Button variant="secondary" title="Not in my account" loading={busy === 'reject'}
            onPress={() => void run('reject', () => api(`/orders/${o.id}/transfers/${claim.id}/reject`, { method: 'POST', body: { reason: 'No matching credit in our account yet' } }), 'Marked as not found. The customer is told.')} />
        </Card>
      ) : null}

      <Card style={{ gap: 8 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Next steps</Text>
        {o.status === 'PENDING_PAYMENT' && can('orders:create') ? (
          <Button variant="secondary" title="Send payment reminder" loading={busy === 'remind'}
            onPress={() => void run('remind', () => api(`/orders/${o.id}/notify`, { method: 'POST', body: { event: 'PAYMENT_REMINDER' } }), 'Reminder sent.')} />
        ) : null}
        {['PAID', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED'].includes(o.status) && can('orders:update_status') ? (
          <>
            {o.status !== 'DISPATCHED' && o.shippingAddress ? <Button title="Out for delivery" loading={busy === 'IN_TRANSIT'} onPress={() => void run('IN_TRANSIT', () => api(`/orders/${o.id}/delivery/status`, { method: 'POST', body: { status: 'IN_TRANSIT' } }), 'Marked on the way. The customer is told.')} /> : null}
            <Button variant="secondary" title={o.shippingAddress ? 'Delivered' : 'Collected'} loading={busy === 'DELIVERED'} onPress={() => void run('DELIVERED', () => api(`/orders/${o.id}/delivery/status`, { method: 'POST', body: { status: 'DELIVERED' } }), 'Marked delivered.')} />
          </>
        ) : null}
        {o.nextStatuses.filter((s) => !['DISPATCHED', 'DELIVERED'].includes(s)).map((s) => (
          <Button key={s} variant={s === 'CANCELLED' ? 'danger' : 'secondary'} title={ACTION_LABEL[s] ?? s} loading={busy === s}
            onPress={() => void run(s, () => api(`/orders/${o.id}/status`, { method: 'POST', body: { status: s } }), `${ORDER_STATUS[s]?.label ?? s}.`)} />
        ))}
        {o.nextStatuses.length === 0 && !['PAID', 'PROCESSING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'PENDING_PAYMENT'].includes(o.status) ? <Muted>Nothing more to do on this order.</Muted> : null}
      </Card>
    </Screen>
  );
}
