import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Text } from 'react-native';
import { Badge, Button, Card, Choice, ErrorBox, Loading, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Overview {
  subscription: {
    status: string; currentPeriodEnd: string; trialEndsAt: string | null; interval?: 'MONTHLY' | 'ANNUAL';
    plan: { code?: string; name: string; pricingModel: string; commissionBps: number | null };
    pendingChange?: { plan: { code: string; name: string }; interval: string; effectiveAt: string } | null;
  } | null;
  openInvoices: Array<{ id: string; number: string; kind: string; amountMinor: string; currency: string; dueAt: string; description: string | null }>;
  paymentCollectionEnabled: boolean;
}
interface Plan { id: string; code: string; name: string; currency: string; monthlyPriceMinor: string | null; annualPriceMinor: string | null; pricingModel: string; commissionBps: number | null; description: string | null }
interface Commission { currency: string; thisMonthMinor: string; unbilledMinor: string; writesBlocked: boolean; rate: { bps: number; source: string } | null }
const day = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(s));

/** Plan, commission and open invoices. Paying opens LiveSell's secure checkout; the invoice is marked paid only after the server verifies it. */
export default function Billing() {
  useTheme();
  const { can } = useAuth();
  const ov = useApi<Overview>(can('billing:manage') ? '/billing/subscription' : null);
  const com = useApi<Commission>(can('billing:manage') ? '/billing/commission' : null);
  const plans = useApi<Plan[]>(can('billing:manage') ? '/plans' : null);
  const [iv, setIv] = useState<'MONTHLY' | 'ANNUAL'>('MONTHLY');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!can('billing:manage')) return <Screen><Notice tone="warn">Only the owner manages billing.</Notice></Screen>;
  if (ov.error) return <Screen><ErrorBox message={ov.error} onRetry={ov.reload} /></Screen>;
  if (!ov.data) return <Loading />;
  const s = ov.data.subscription;

  async function pay(id: string) {
    setBusy(id);
    setMsg(null);
    try {
      const r = await api<{ checkoutUrl: string }>(`/billing/invoices/${id}/pay`, { method: 'POST', body: {} });
      await WebBrowser.openBrowserAsync(r.checkoutUrl);
      await Promise.all([ov.reload(), com.reload()]); // back from checkout: show the verified status
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen refreshing={ov.loading} onRefresh={() => { void ov.reload(); void com.reload(); }}>
      {msg ? <Notice tone="bad">{msg}</Notice> : null}
      {note ? <Notice tone="good">{note}</Notice> : null}
      {com.data?.writesBlocked ? <Notice tone="bad">A commission invoice is overdue. Changes are paused until it is paid.</Notice> : null}
      <Card style={{ gap: 4 }}>
        <Row><Text style={{ fontSize: 18, fontWeight: '700', color: c.ink }}>{s?.plan.name ?? 'No plan'}</Text>{s ? <Badge tone={s.status === 'ACTIVE' ? 'good' : s.status === 'TRIALING' ? 'info' : 'warn'}>{s.status.toLowerCase().replace('_', ' ')}</Badge> : null}</Row>
        {s ? <Muted>{s.status === 'TRIALING' && s.trialEndsAt ? `Free trial until ${day(s.trialEndsAt)}` : `Current period until ${day(s.currentPeriodEnd)}`}</Muted> : null}
        {s?.plan.pricingModel === 'COMMISSION' ? <Muted>No monthly fee: {((s.plan.commissionBps ?? 0) / 100).toFixed(1)}% of each verified sale.</Muted> : null}
      </Card>
      {com.data && com.data.rate && com.data.rate.bps > 0 ? (
        <Card style={{ gap: 4 }}>
          <Text style={{ fontWeight: '700', color: c.ink }}>Commission</Text>
          <Row><Muted>This month (collected by you)</Muted><Text style={{ color: c.ink }}>{money(com.data.thisMonthMinor, com.data.currency)}</Text></Row>
          <Row><Muted>Not yet invoiced</Muted><Text style={{ color: c.ink }}>{money(com.data.unbilledMinor, com.data.currency)}</Text></Row>
        </Card>
      ) : null}
      <Card style={{ gap: 8 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Amount due</Text>
        {ov.data.openInvoices.length === 0 ? <Muted>Nothing to pay.</Muted> : ov.data.openInvoices.map((i) => (
          <Card key={i.id} style={{ gap: 6 }}>
            <Row><Text style={{ color: c.ink, flex: 1 }}>{i.description ?? i.number}</Text><Text style={{ fontWeight: '700', color: c.ink }}>{money(i.amountMinor, i.currency)}</Text></Row>
            <Muted>{i.number} · due {day(i.dueAt)}</Muted>
            {ov.data!.paymentCollectionEnabled ? <Button title="Pay now" loading={busy === i.id} disabled={!!busy} onPress={() => void pay(i.id)} /> : <Muted>Online payment is being connected; your access isn’t paused meanwhile.</Muted>}
          </Card>
        ))}
      </Card>
      <Card style={{ gap: 10 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Change plan</Text>
        <Muted>{s?.status === 'TRIALING' ? 'Switching during your trial is free and immediate.' : 'Upgrades are prorated. Downgrades start at the end of your billing period.'}</Muted>
        <Choice label="Billing interval" value={iv} onChange={setIv} options={[['MONTHLY', 'Monthly'], ['ANNUAL', 'Yearly']]} />
        {s?.pendingChange ? <Notice tone="info">{s.pendingChange.plan.name} starts on {day(s.pendingChange.effectiveAt)}.</Notice> : null}
        {plans.error ? <ErrorBox message={plans.error} onRetry={plans.reload} /> : !plans.data ? <Loading /> : plans.data.map((p) => {
          const commission = p.pricingModel === 'COMMISSION';
          const planIv = commission ? 'MONTHLY' : iv;
          const price = planIv === 'MONTHLY' ? p.monthlyPriceMinor : p.annualPriceMinor;
          const current = !!s && ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(s.status) && s.plan.code === p.code && (s.interval ?? 'MONTHLY') === planIv;
          return (
            <Card key={p.id} style={{ gap: 6, borderWidth: current ? 2 : undefined, borderColor: current ? c.brand : undefined }}>
              <Row><Text style={{ color: c.ink, fontWeight: '700', flex: 1 }}>{p.name}</Text>
                <Text style={{ color: c.ink, fontWeight: '700' }}>{commission ? `${((p.commissionBps ?? 0) / 100).toFixed(1)}% per sale` : price === null ? 'Custom' : `${money(price, p.currency)}/${planIv === 'MONTHLY' ? 'mo' : 'yr'}`}</Text></Row>
              {p.description ? <Muted>{p.description}</Muted> : null}
              {current ? <Badge tone="good">Current plan</Badge> : price === null && !commission ? <Muted>Contact LiveSell sales for this plan.</Muted> : (
                <Button variant="secondary" title={`Switch to ${p.name}`} loading={busy === `plan-${p.code}`} disabled={!!busy} onPress={() => {
                  setBusy(`plan-${p.code}`);
                  setMsg(null);
                  api<{ action: string; effectiveAt?: string }>('/billing/subscription/change', { method: 'POST', body: { planCode: p.code, interval: planIv } })
                    .then((r) => {
                      setNote(r.action === 'changed' ? `You’re now on ${p.name}.` : r.action === 'scheduled' ? `${p.name} starts on ${day(r.effectiveAt!)}.` : r.action === 'pending_change_cancelled' ? 'Scheduled change cancelled.' : `An invoice for ${p.name} was created. Pay it below to switch.`);
                      return Promise.all([ov.reload(), com.reload()]);
                    })
                    .catch((e: Error) => setMsg(e.message))
                    .finally(() => setBusy(null));
                }} />
              )}
            </Card>
          );
        })}
      </Card>
    </Screen>
  );
}
