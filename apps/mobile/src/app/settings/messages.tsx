import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { Button, Card, ErrorBox, Field, Loading, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

type Ch = 'whatsapp' | 'sms' | 'email';
interface Prefs { enabled: boolean; events: Record<string, Record<Ch, boolean>>; paymentReminderHoursBefore: number; abandonedAfterMinutes: number }
const EVENTS: Array<[string, string]> = [
  ['ORDER_PLACED', 'Order placed (invoice by email)'], ['PAYMENT_RECEIVED', 'Payment confirmed (receipt by email)'], ['PAYMENT_REMINDER', 'Payment reminder'],
  ['ABANDONED_CHECKOUT', 'Unpaid online order nudge'], ['TRANSFER_REPORTED', 'Bank transfer report received'], ['TRANSFER_NOT_FOUND', 'Bank transfer not found'],
  ['ORDER_DISPATCHED', 'Order dispatched'], ['ORDER_DELIVERED', 'Order delivered'], ['ORDER_CANCELLED', 'Order cancelled'], ['REFUND_COMPLETED', 'Refund completed'],
];
const CHS: Array<[Ch, string]> = [['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']];

/** Which automatic messages customers get, on which channel, and reminder timing (same settings as the web). */
export default function MessageSettings() {
  useTheme();
  const { can } = useAuth();
  const res = useApi<Prefs>(can('store:manage') ? '/notifications/preferences' : null);
  const [p, setP] = useState<Prefs | null>(null);
  const [hours, setHours] = useState('');
  const [mins, setMins] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  useEffect(() => { if (res.data) { setP(res.data); setHours(String(res.data.paymentReminderHoursBefore)); setMins(String(res.data.abandonedAfterMinutes)); } }, [res.data]);

  if (!can('store:manage')) return <Screen><Notice tone="warn">Only the owner or a manager can change customer messages.</Notice></Screen>;
  if (res.error) return <Screen><ErrorBox message={res.error} onRetry={res.reload} /></Screen>;
  if (!p) return <Loading />;
  const h = /^\d{1,2}$/.test(hours) && Number(hours) <= 72 ? Number(hours) : NaN;
  const m = /^\d{1,4}$/.test(mins) && Number(mins) <= 1440 ? Number(mins) : NaN;
  const toggle = (e: string, ch: Ch) => setP({ ...p, events: { ...p.events, [e]: { ...p.events[e], [ch]: !p.events[e]?.[ch] } } });

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      res.setData(await api<Prefs>('/notifications/preferences', { method: 'PUT', body: { ...p, paymentReminderHoursBefore: h, abandonedAfterMinutes: m } }));
      setMsg({ tone: 'good', text: 'Message settings saved.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <Card style={{ gap: 6 }}>
        <Row><Text style={{ color: c.ink, flex: 1, fontWeight: '700' }}>Send automatic messages</Text>
          <Switch value={p.enabled} onValueChange={(v) => setP({ ...p, enabled: v })} trackColor={{ true: c.brand, false: c.line }} thumbColor={c.surface} accessibilityLabel="Send automatic messages" /></Row>
        <Muted>WhatsApp goes only to customers who agreed to it and never to anyone who replied STOP. If WhatsApp can’t be used, SMS is sent instead (when ticked). Each message counts towards your monthly limits.</Muted>
      </Card>
      <View style={{ opacity: p.enabled ? 1 : 0.45, gap: 12 }} pointerEvents={p.enabled ? 'auto' : 'none'}>
        {EVENTS.map(([e, label]) => (
          <Card key={e} style={{ gap: 8 }}>
            <Text style={{ color: c.ink, fontWeight: '600' }}>{label}</Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {CHS.map(([ch, l]) => {
                const on = !!p.events[e]?.[ch];
                return (
                  <Pressable key={ch} onPress={() => toggle(e, ch)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`${label} by ${l}`}
                    style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: on ? c.brand : c.line, backgroundColor: on ? c.brandSoft : c.surface }}>
                    <Text style={{ color: on ? c.brand : c.ink3, fontWeight: on ? '700' : '500' }}>{on ? '✓ ' : ''}{l}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>
        ))}
        <Card style={{ gap: 10 }}>
          <Field label="Payment reminder: hours before the stock hold ends (0 = off, max 72)" value={hours} onChangeText={setHours} keyboardType="number-pad" error={Number.isNaN(h) ? 'Enter 0–72' : null} />
          <Field label="Nudge unpaid online orders after (minutes, 0 = off, max 1440)" value={mins} onChangeText={setMins} keyboardType="number-pad" error={Number.isNaN(m) ? 'Enter 0–1440' : null} />
        </Card>
      </View>
      <Button title="Save message settings" loading={busy} disabled={Number.isNaN(h) || Number.isNaN(m)} onPress={() => void save()} />
    </Screen>
  );
}
