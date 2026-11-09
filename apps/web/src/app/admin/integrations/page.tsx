'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { WhatsappAdminCard } from '@/components/whatsapp-admin-card';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageLoading, Select } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money';
import { CHANNEL_LABEL, NOTIFICATION_STATUS } from '@/lib/messaging-labels';
import type { MessagingSettings, NotificationList, PlatformUsage, VeltrixStatus } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const CHANNELS = ['WHATSAPP', 'SMS', 'EMAIL'] as const;
const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));

/** MASTER-SPEC §15 "dedicated integration settings page": Veltrix connection, messaging prices and limits, usage. */
export default function IntegrationsPage() {
  const { me } = useAuth();
  const isAdmin = me?.platformRole === 'PLATFORM_ADMIN';
  const status = useApi<VeltrixStatus>('/admin/integrations/veltrix', { tenant: false });
  const settings = useApi<MessagingSettings>('/admin/messaging/settings', { tenant: false });
  const usage = useApi<PlatformUsage>('/admin/messaging/usage', { tenant: false });
  const failed = useApi<NotificationList>('/admin/messaging/notifications?status=FAILED&pageSize=20', { tenant: false });

  return (
    <div className="space-y-6">
      <PageHeader title="Integrations" description="Veltrix sends LiveSell’s email, SMS and WhatsApp messages and runs business registry checks. Keys live in the server environment and are never shown here." />

      <Card>
        <CardHeader title="Veltrix" action={status.data && <Badge tone={status.data.configured && !status.data.error ? 'good' : 'warn'}>{!status.data.configured ? 'Not configured' : status.data.error ? 'Connection problem' : 'Connected'}</Badge>} />
        <div className="space-y-3 p-5 text-sm">
          {status.error ? <ErrorState message={status.error} onRetry={status.reload} /> : !status.data ? <PageLoading /> : <>
            {!status.data.configured && <Alert tone="info">Set VELTRIX_ENABLED, VELTRIX_BASE_URL and VELTRIX_API_KEY on the API server, plus a sender for each channel, then restart it.</Alert>}
            {status.data.error && <Alert tone="bad">{status.data.error}</Alert>}
            <dl className="grid gap-3 sm:grid-cols-2">
              {status.data.account && <div><dt className="text-ink-3">Account</dt><dd>{status.data.account.name ?? '—'} · {status.data.account.email ?? '—'}</dd></div>}
              {status.data.wallet && <div><dt className="text-ink-3">Veltrix wallet</dt><dd className="tabular">{status.data.wallet.balance}</dd></div>}
              <div className="sm:col-span-2"><dt className="text-ink-3">Channels</dt><dd className="mt-1 flex flex-wrap gap-2">
                {CHANNELS.map((c) => <Badge key={c} tone={status.data!.channels[c] ? 'good' : 'neutral'}>{CHANNEL_LABEL[c]} {status.data!.channels[c] ? 'on' : 'off'}</Badge>)}
                <Badge tone={status.data.verify.configured ? 'good' : 'neutral'}>Verify (CAC checks) {status.data.verify.configured ? 'on' : 'off'}</Badge>
              </dd></div>
            </dl>
            {isAdmin && status.data.configured && <TestSend />}
          </>}
        </div>
      </Card>

      <WhatsappAdminCard canEdit={isAdmin} />

      {settings.error ? <ErrorState message={settings.error} onRetry={settings.reload} /> : !settings.data ? <PageLoading /> : <PricingCard s={settings.data} canEdit={isAdmin} onSaved={() => void settings.reload()} />}

      <Card>
        <CardHeader title="Seller usage this month" description={usage.data ? `Period ${usage.data.period}. Seller-attributed messages and their cost.` : undefined} />
        {usage.error ? <div className="p-5"><ErrorState message={usage.error} onRetry={usage.reload} /></div>
          : !usage.data ? <PageLoading />
          : usage.data.stores.length === 0 ? <EmptyState title="No seller messages yet">Messages sent on behalf of sellers appear here with their cost.</EmptyState>
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3"><tr className="border-b border-line"><th className="px-5 py-2.5 font-medium">Store</th><th className="px-5 py-2.5 font-medium">Messages</th><th className="px-5 py-2.5 text-right font-medium">Cost</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {usage.data.stores.map((s) => (
                    <tr key={s.tenantId}><td className="px-5 py-3">{s.businessName} <span className="text-ink-3">/{s.slug}</span></td>
                      <td className="px-5 py-3 text-ink-2">{Object.entries(s.channels).map(([c, n]) => `${CHANNEL_LABEL[c] ?? c} ${n}`).join(' · ')}</td>
                      <td className="px-5 py-3 text-right tabular">{formatMoney(s.costMinor)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {usage.data && <p className="border-t border-line px-5 py-3 text-[13px] text-ink-3">Total {usage.data.totals.messages} messages · {formatMoney(usage.data.totals.costMinor)} · {usage.data.totals.failed} failed this month</p>}
      </Card>

      <Card>
        <CardHeader title="Failed messages" description="Codes and sign-in links are never stored, so they can’t be re-sent — the person asks again instead." />
        {failed.error ? <div className="p-5"><ErrorState message={failed.error} onRetry={failed.reload} /></div>
          : !failed.data ? <PageLoading />
          : failed.data.items.length === 0 ? <EmptyState title="No failed messages" />
          : <FailedList list={failed.data} canRetry={isAdmin} onChanged={() => void failed.reload()} />}
      </Card>
    </div>
  );
}

function TestSend() {
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('EMAIL');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  async function send() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ status: string; error: string | null }>('/admin/integrations/veltrix/test', { method: 'POST', body: { channel, to: to.trim() }, tenant: false });
      setMsg(r.status === 'FAILED' ? { tone: 'bad', text: `Not sent: ${r.error ?? 'unknown error'}` } : { tone: 'good', text: r.status === 'QUEUED' ? 'Veltrix is not responding; the message is queued for retry.' : 'Sent. Check the destination.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-line p-4">
      <p className="font-medium">Send a test message</p>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="grid gap-2 sm:grid-cols-[160px_1fr_auto] sm:items-end">
        <Field label="Channel">{(p) => <Select {...p} value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>{CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</Select>}</Field>
        <Field label={channel === 'EMAIL' ? 'Email address' : 'Phone number'}>{(p) => <Input {...p} value={to} onChange={(e) => setTo(e.target.value)} placeholder={channel === 'EMAIL' ? 'you@livesell.africa' : '0803 123 4567'} />}</Field>
        <Button loading={busy} disabled={to.trim().length < 5} onClick={() => void send()}>Send test</Button>
      </div>
    </div>
  );
}

function PricingCard({ s, canEdit, onSaved }: { s: MessagingSettings; canEdit: boolean; onSaved: () => void }) {
  const toNaira = (k: number) => (k / 100).toString();
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  useEffect(() => {
    setPrices(Object.fromEntries(CHANNELS.map((c) => [c, toNaira(s.prices[c])])));
    setLimits(Object.fromEntries(CHANNELS.map((c) => [c, String(s.limits[c])])));
  }, [s]);
  const parsedPrices = Object.fromEntries(CHANNELS.map((c) => [c, /^\d+(\.\d{1,2})?$/.test(prices[c] ?? '') ? Math.round(Number(prices[c]) * 100) : NaN]));
  const parsedLimits = Object.fromEntries(CHANNELS.map((c) => [c, /^\d+$/.test(limits[c] ?? '') ? Number(limits[c]) : NaN]));
  const valid = [...Object.values(parsedPrices), ...Object.values(parsedLimits)].every((v) => Number.isInteger(v));
  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api('/admin/messaging/settings', { method: 'PUT', body: { prices: parsedPrices, limits: parsedLimits }, tenant: false });
      setMsg({ tone: 'good', text: 'Saved. New prices apply to messages sent from now on.' });
      onSaved();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader title="Messaging prices and seller limits" description="What a seller is charged per message sent on their behalf, and how many they can send per month (a plan can set its own limits)." />
      <div className="space-y-3 p-5">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          {CHANNELS.map((c) => (
            <fieldset key={c} disabled={!canEdit} className="space-y-2 rounded-lg border border-line p-3">
              <legend className="px-1 text-sm font-medium">{CHANNEL_LABEL[c]}</legend>
              <Field label="Price per message (₦)">{(p) => <Input {...p} inputMode="decimal" value={prices[c] ?? ''} onChange={(e) => setPrices({ ...prices, [c]: e.target.value })} />}</Field>
              <Field label="Monthly limit per seller">{(p) => <Input {...p} inputMode="numeric" value={limits[c] ?? ''} onChange={(e) => setLimits({ ...limits, [c]: e.target.value })} />}</Field>
            </fieldset>
          ))}
        </div>
        {canEdit && <Button loading={busy} disabled={!valid} onClick={() => void save()}>Save prices and limits</Button>}
      </div>
    </Card>
  );
}

function FailedList({ list, canRetry, onChanged }: { list: NotificationList; canRetry: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function retry(id: string) {
    setBusy(id);
    setMsg(null);
    try {
      const r = await api<{ status: string; error: string | null }>(`/admin/messaging/notifications/${id}/retry`, { method: 'POST', body: {}, tenant: false });
      setMsg(r.status === 'FAILED' ? `Still failing: ${r.error}` : 'Sent.');
      onChanged();
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      {msg && <p role="status" className="px-5 pt-3 text-sm text-ink-2">{msg}</p>}
      <ul className="divide-y divide-line">
        {list.items.map((n) => (
          <li key={n.id} className="flex flex-col gap-1 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p><Badge tone={NOTIFICATION_STATUS[n.status][1]}>{CHANNEL_LABEL[n.channel]}</Badge> <span className="font-medium">{n.type.replace(/_/g, ' ').toLowerCase()}</span> <span className="text-ink-3">to {n.destination}{n.store ? ` · ${n.store.businessName}` : ''}</span></p>
              <p className="text-[13px] text-bad">{n.error}</p>
              <p className="text-[12px] text-ink-3">{when(n.createdAt)} · {n.attempts} attempt(s)</p>
            </div>
            {canRetry && n.retryable && n.error !== 'LIMIT_REACHED' && <Button size="sm" variant="secondary" loading={busy === n.id} onClick={() => void retry(n.id)}>Send again</Button>}
          </li>
        ))}
      </ul>
    </>
  );
}
