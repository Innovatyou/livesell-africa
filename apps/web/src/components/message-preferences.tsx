'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardHeader, ErrorState, Field, Input, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { ORDER_EVENT_LABEL } from '@/lib/messaging-labels';
import type { EventChannels, MessagePreferences, OrderEvent } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const CH: Array<[keyof EventChannels, string]> = [['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']];

/** Which automatic customer messages the store sends (MASTER-SPEC §15), per event and channel, plus reminder timing. */
export function MessagePreferencesCard() {
  const res = useApi<MessagePreferences>('/notifications/preferences');
  const [p, setP] = useState<MessagePreferences | null>(null);
  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (!res.data) return;
    setP(res.data);
    setHours(String(res.data.paymentReminderHoursBefore));
    setMinutes(String(res.data.abandonedAfterMinutes));
  }, [res.data]);

  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (!p) return <Card><PageLoading /></Card>;

  const h = /^\d{1,2}$/.test(hours) && Number(hours) <= 72 ? Number(hours) : NaN;
  const m = /^\d{1,4}$/.test(minutes) && Number(minutes) <= 1440 ? Number(minutes) : NaN;
  const valid = Number.isInteger(h) && Number.isInteger(m);
  const toggle = (e: OrderEvent, c: keyof EventChannels) => setP({ ...p, events: { ...p.events, [e]: { ...p.events[e], [c]: !p.events[e][c] } } });

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const saved = await api<MessagePreferences>('/notifications/preferences', { method: 'PUT', body: { ...p, paymentReminderHoursBefore: h, abandonedAfterMinutes: m } });
      res.setData(saved);
      setMsg({ tone: 'good', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Automatic customer messages" description="WhatsApp goes only to customers who agreed to it and never to anyone who replied STOP. When WhatsApp can’t be used, SMS is sent instead (if ticked). Each message counts towards your monthly limits." />
      <div className="space-y-4 p-5">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={p.enabled} onChange={() => setP({ ...p, enabled: !p.enabled })} />
          Send automatic messages to my customers
        </label>
        <fieldset disabled={!p.enabled} className="overflow-x-auto disabled:opacity-50">
          <table className="w-full min-w-[480px] text-sm">
            <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3"><tr className="border-b border-line"><th className="py-2 font-medium">Message</th>{CH.map(([, l]) => <th key={l} className="w-20 py-2 text-center font-medium">{l}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {(Object.keys(ORDER_EVENT_LABEL) as OrderEvent[]).map((e) => (
                <tr key={e}>
                  <td className="py-2.5 pr-3">{ORDER_EVENT_LABEL[e]}</td>
                  {CH.map(([c, l]) => (
                    <td key={c} className="py-2.5 text-center">
                      <input type="checkbox" className="h-4 w-4 accent-brand-600" aria-label={`${ORDER_EVENT_LABEL[e]} by ${l}`} checked={p.events[e][c]} onChange={() => toggle(e, c)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payment reminder, hours before the stock hold ends" hint="0 turns it off (max 72)" error={Number.isNaN(h) ? 'Enter 0–72' : undefined}>
            {(f) => <Input {...f} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />}
          </Field>
          <Field label="Nudge unpaid online orders after (minutes)" hint="0 turns it off (max 1440)" error={Number.isNaN(m) ? 'Enter 0–1440' : undefined}>
            {(f) => <Input {...f} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />}
          </Field>
        </div>
        <Button loading={busy} disabled={!valid} onClick={() => void save()}>Save message settings</Button>
      </div>
    </Card>
  );
}
