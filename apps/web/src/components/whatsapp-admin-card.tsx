'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, ErrorState, Field, Input, PageLoading, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { ORDER_EVENT_LABEL } from '@/lib/messaging-labels';
import type { OrderEvent, WhatsappAdminSettings } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const key = (t: { name: string; language: string } | null) => (t ? `${t.name}|${t.language}` : '');

/**
 * Platform WhatsApp automation (Phase 9): the number customers order on, Veltrix forwarding of its inbound messages
 * to LiveSell, and which approved template carries each order update outside Meta's 24-hour window.
 */
export function WhatsappAdminCard({ canEdit }: { canEdit: boolean }) {
  const res = useApi<WhatsappAdminSettings>('/admin/whatsapp', { tenant: false });
  const [number, setNumber] = useState('');
  const [map, setMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'connect' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (!res.data) return;
    setNumber(res.data.platformNumber ?? '');
    setMap(Object.fromEntries(res.data.events.map((e) => [e.event, key(e.template)])));
  }, [res.data]);

  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (!res.data) return <Card><PageLoading /></Card>;
  const s = res.data;
  const numberOk = number === '' || /^\+[1-9]\d{7,14}$/.test(number.replace(/\s/g, ''));

  async function save() {
    setBusy('save');
    setMsg(null);
    try {
      const templates = Object.fromEntries(s.events.map((e) => {
        const v = map[e.event];
        if (!v) return [e.event, null];
        const [name, language] = v.split('|');
        return [e.event, { name, language }];
      }));
      res.setData(await api<WhatsappAdminSettings>('/admin/whatsapp', { method: 'PUT', body: { platformNumber: number ? number.replace(/\s/g, '') : null, templates }, tenant: false }));
      setMsg({ tone: 'good', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }
  async function connect() {
    setBusy('connect');
    setMsg(null);
    try {
      res.setData(await api<WhatsappAdminSettings>('/admin/whatsapp/forwarding', { method: 'POST', body: {}, tenant: false }));
      setMsg({ tone: 'good', text: 'Forwarding connected. Customer messages to the platform number now reach LiveSell; the Veltrix bot stays silent for that number.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="WhatsApp ordering and order updates"
        description="Customers message the platform number with a store name and product code to order. Order updates use free text within 24 hours of the customer’s last message, and an approved template otherwise."
        action={<Badge tone={s.forwarding.connected && s.channelEnabled ? 'good' : 'warn'}>{!s.channelEnabled ? 'WhatsApp off in Veltrix' : s.forwarding.connected ? 'Receiving messages' : 'Not receiving messages'}</Badge>}
      />
      <div className="space-y-4 p-5 text-sm">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {!s.channelEnabled && <Alert tone="info">Set VELTRIX_WHATSAPP_SERVER_UID on the API server to the Veltrix WhatsApp server for the platform number, then restart it.</Alert>}

        <div className="space-y-2 rounded-lg border border-line p-4">
          <p className="font-medium">Inbound messages</p>
          <p className="text-ink-2">Veltrix forwards each message to <span className="break-all font-mono text-[12px]">{s.forwarding.url}</span>, signed with a secret that LiveSell keeps encrypted.{s.forwarding.connectedAt ? ` Connected ${new Date(s.forwarding.connectedAt).toLocaleString('en-NG')}.` : ''}</p>
          <p className="text-[13px] text-ink-3">Veltrix forwards only messages it has verified came from Meta. In Veltrix, open the platform number (WhatsApp servers → edit → Webhook security) and mark it “Connected with Facebook”, or enter its Meta app secret — otherwise customer messages are not passed on.</p>
          {canEdit && <Button size="sm" variant="secondary" loading={busy === 'connect'} disabled={!s.channelEnabled} onClick={() => void connect()}>{s.forwarding.connected ? 'Reconnect (new secret)' : 'Connect forwarding'}</Button>}
        </div>

        <Field label="Platform WhatsApp number" hint="Shown on store pages as “Order on WhatsApp”. International format, e.g. +2348031234567." error={numberOk ? undefined : 'Use international format, e.g. +2348031234567'}>
          {(f) => <Input {...f} disabled={!canEdit} value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+234…" />}
        </Field>

        <div className="space-y-2">
          <p className="font-medium">Templates for order updates</p>
          {s.approvedError && <Alert tone="bad">Couldn’t load approved templates from Veltrix: {s.approvedError}</Alert>}
          {!s.approvedError && s.channelEnabled && s.approvedTemplates.length === 0 && <Alert tone="info">No approved templates on the platform number yet. Create them in Meta Business Manager (Utility category, numbered values, no media header); until then updates outside the 24-hour window go by SMS.</Alert>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3"><tr className="border-b border-line"><th className="py-2 font-medium">Update</th><th className="py-2 font-medium">Template</th><th className="py-2 font-medium">Values sent, in order</th></tr></thead>
              <tbody className="divide-y divide-line">
                {s.events.map((e) => {
                  const fits = s.approvedTemplates.filter((t) => t.params === e.params.length && !t.header && !t.named);
                  const current = map[e.event] ?? '';
                  const known = !current || fits.some((t) => key(t) === current);
                  return (
                    <tr key={e.event}>
                      <td className="py-2 pr-3">{ORDER_EVENT_LABEL[e.event as OrderEvent]?.replace(/ \(.*\)$/, '') ?? e.event}</td>
                      <td className="py-2 pr-3">
                        <Select aria-label={`Template for ${e.event}`} disabled={!canEdit} value={current} onChange={(ev) => setMap({ ...map, [e.event]: ev.target.value })}>
                          <option value="">None (SMS outside 24 h)</option>
                          {!known && <option value={current}>{current.replace('|', ' · ')} (not approved)</option>}
                          {fits.map((t) => <option key={key(t)} value={key(t)}>{t.name} · {t.language}</option>)}
                        </Select>
                      </td>
                      <td className="py-2 text-[12px] text-ink-3">{e.params.map((p, i) => `{{${i + 1}}} ${p}`).join(', ')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        {canEdit && <Button loading={busy === 'save'} disabled={!numberOk} onClick={() => void save()}>Save WhatsApp settings</Button>}
      </div>
    </Card>
  );
}
