'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { CommissionCard } from '@/components/commission-card';
import { planBullets } from '@/components/plan-features';
import { IntervalToggle } from '@/components/pricing-table';
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, EmptyState, ErrorState, PageLoading, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBps, formatMoney, toMinor } from '@/lib/money';
import type { BillingOverview, Interval, Invoice, Plan, SubscriptionStatus } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const date = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(s));
const STATUS: Record<SubscriptionStatus, [string, 'good' | 'warn' | 'bad' | 'info' | 'neutral']> = {
  TRIALING: ['Free trial', 'info'], ACTIVE: ['Active', 'good'], PAST_DUE: ['Payment due', 'warn'], CANCELLED: ['Cancelled', 'neutral'], EXPIRED: ['Expired', 'bad'],
};
const INVOICE_STATUS: Record<Invoice['status'], [string, 'good' | 'warn' | 'bad' | 'neutral']> = {
  OPEN: ['Open', 'warn'], PAID: ['Paid', 'good'], VOID: ['Void', 'neutral'], DRAFT: ['Draft', 'neutral'], UNCOLLECTIBLE: ['Uncollectible', 'bad'],
};
const KIND: Record<Invoice['kind'], string> = { TRIAL_CONVERSION: 'First period', RENEWAL: 'Renewal', UPGRADE: 'Upgrade', REACTIVATION: 'Reactivation', COMMISSION: 'Commission' };

/** Price per month in kobo for ordering plans (annual / 12, integer). */
const perMonth = (p: Plan, i: Interval) => {
  const price = i === 'MONTHLY' ? p.monthlyPriceMinor : p.annualPriceMinor;
  return price === null ? null : i === 'MONTHLY' ? toMinor(price) : toMinor(price) / 12n;
};

export default function BillingPage() {
  const { can, reload: reloadSession } = useAuth();
  const allowed = can('billing:manage');
  const overview = useApi<BillingOverview>(allowed ? '/billing/subscription' : null);
  const plans = useApi<Plan[]>(allowed ? '/plans' : null);
  const invoices = useApi<Invoice[]>(allowed ? '/billing/invoices' : null);
  const [interval, setInterval] = useState<Interval | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);

  if (!allowed) return <Card><EmptyState title="Only the owner manages billing" /></Card>;
  if (overview.error) return <ErrorState message={overview.error} onRetry={overview.reload} />;
  if (!overview.data || !plans.data) return <PageLoading />;

  const o = overview.data;
  const sub = o.subscription;
  const iv: Interval = interval ?? sub?.interval ?? 'MONTHLY';
  const currentPm = sub ? perMonth(sub.plan as Plan, sub.interval) : null;

  /** Sends the owner to Paystack (LiveSell's billing account); the invoice is marked paid only after the server verifies the payment. */
  async function payInvoice(id: string) {
    setBusy(`pay-${id}`);
    setMsg(null);
    try {
      const r = await api<{ checkoutUrl: string }>(`/billing/invoices/${id}/pay`, { method: 'POST', body: {} });
      window.location.assign(r.checkoutUrl);
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
      setBusy(null);
    }
  }

  async function run(key: string, fn: () => Promise<{ action?: string; effectiveAt?: string } | unknown>, describe: (r: any) => string) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ tone: 'good', text: describe(r) });
      await Promise.all([overview.reload(), invoices.reload(), reloadSession()]);
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  const choose = (p: Plan) => run(`plan-${p.code}`,
    () => api('/billing/subscription/change', { method: 'POST', body: { planCode: p.code, interval: iv } }),
    (r: { action: string; effectiveAt?: string }) =>
      r.action === 'changed' ? `You're now on ${p.name}.`
      : r.action === 'scheduled' ? `${p.name} starts on ${date(r.effectiveAt!)}. You keep your current plan until then.`
      : r.action === 'pending_change_cancelled' ? 'Scheduled change cancelled. You stay on your current plan.'
      : `An invoice for ${p.name} has been created. Your plan switches as soon as it is paid.`);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Plan & billing" description="Your LiveSell subscription. This is separate from payments your customers make to you." />
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      <Card>
        <CardHeader
          title={sub ? <span className="flex items-center gap-2">{sub.plan.name}<Badge tone={STATUS[sub.status][1]}>{STATUS[sub.status][0]}</Badge></span> : 'No subscription'}
          description={sub && describeSub(sub)}
        />
        {sub && (
          <div className="grid gap-5 p-5 md:grid-cols-[1fr_auto]">
            <div className="space-y-4">
              {sub.pendingChange && (
                <Alert tone="info" action={<Button size="sm" variant="secondary" loading={busy === 'cancel-pending'} disabled={!!busy} onClick={() => void run('cancel-pending', () => api('/billing/subscription/cancel-pending-change', { method: 'POST', body: {} }), () => 'Scheduled change cancelled.')}>Keep current plan</Button>}>
                  Switching to <b>{sub.pendingChange.plan.name}</b> ({sub.pendingChange.interval.toLowerCase()}) on {date(sub.pendingChange.effectiveAt)}.
                </Alert>
              )}
              {sub.cancelAtPeriodEnd && (
                <Alert tone="warn" action={<Button size="sm" variant="secondary" loading={busy === 'resume'} disabled={!!busy} onClick={() => void run('resume', () => api('/billing/subscription/resume', { method: 'POST', body: {} }), () => 'Your subscription will continue.')}>Keep subscription</Button>}>
                  Your subscription ends on {date(sub.status === 'TRIALING' && sub.trialEndsAt ? sub.trialEndsAt : sub.currentPeriodEnd)}.
                </Alert>
              )}
              <CommissionNote o={o} />
              <Usage label="Team members" used={o.usage.staff} limit={o.limits?.staff ?? null} hint="Includes pending invitations" />
              <Usage label="Products" used={o.usage.products} limit={o.limits?.products ?? null} />
            </div>
            {['TRIALING', 'ACTIVE'].includes(sub.status) && !sub.cancelAtPeriodEnd && (
              <div className="md:text-right">
                <Button variant="ghost" size="sm" loading={busy === 'cancel'} disabled={!!busy}
                  onClick={() => { if (window.confirm('Cancel your subscription at the end of the current period?')) void run('cancel', () => api('/billing/subscription/cancel', { method: 'POST', body: {} }), () => 'Cancellation scheduled. You keep access until the end of the period.'); }}>
                  Cancel subscription
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      <CommissionCard paymentCollectionEnabled={o.paymentCollectionEnabled} />

      {o.openInvoices.filter((i) => i.kind !== 'COMMISSION').length > 0 && (
        <Card>
          <CardHeader title="Amount due" />
          <div className="space-y-3 p-5">
            {o.openInvoices.filter((inv) => inv.kind !== 'COMMISSION').map((inv) => (
              <div key={inv.id} className="flex flex-col justify-between gap-2 rounded-lg border border-line p-4 sm:flex-row sm:items-center">
                <div>
                  <p className="font-medium">{inv.description ?? inv.plan.name} <span className="font-normal text-ink-3">· {KIND[inv.kind]}</span></p>
                  <p className="text-[13px] text-ink-3">Invoice {inv.number} · covers {date(inv.periodStart)} – {date(inv.periodEnd)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-lg font-semibold tabular">{formatMoney(inv.amountMinor, inv.currency)}</p>
                  {o.paymentCollectionEnabled && <Button size="sm" loading={busy === `pay-${inv.id}`} disabled={!!busy} onClick={() => void payInvoice(inv.id)}>Pay now</Button>}
                </div>
              </div>
            ))}
            {!o.paymentCollectionEnabled && (
              <Alert tone="info" title="Online payment opens soon">
                Card and bank payments for LiveSell plans are being connected. Your invoice stays open and your access continues
                {sub?.accessEndsAt ? ` until ${date(sub.accessEndsAt)}` : ''}. We&apos;ll email you as soon as you can pay.
              </Alert>
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Choose a plan" description={sub?.status === 'TRIALING' ? 'Switching during your trial is free and takes effect immediately.' : 'Upgrades are prorated. Downgrades take effect at the end of your billing period.'} action={<IntervalToggle value={iv} onChange={setInterval} />} />
        <div className="grid gap-4 p-5 md:grid-cols-2 lg:grid-cols-4">
          {plans.data.map((p) => {
            const isCommission = p.pricingModel === 'COMMISSION';
            const planIv: Interval = isCommission ? 'MONTHLY' : iv; // commission plans have no annual option
            const price = planIv === 'MONTHLY' ? p.monthlyPriceMinor : p.annualPriceMinor;
            const current = sub && ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(sub.status) && sub.plan.code === p.code && sub.interval === planIv;
            const pending = sub?.pendingChange?.plan.code === p.code && sub.pendingChange.interval === iv;
            const pm = perMonth(p, iv);
            const verb = !sub || ['EXPIRED', 'CANCELLED'].includes(sub.status) ? 'Choose'
              : sub.status === 'TRIALING' ? 'Switch' : pm !== null && currentPm !== null && pm > currentPm ? 'Upgrade' : 'Switch';
            return (
              <div key={p.id} className={cx('flex flex-col rounded-[var(--radius-card)] border p-4', current ? 'border-brand-500 bg-brand-50/40' : 'border-line')}>
                <p className="font-semibold">{p.name}</p>
                <p className="mt-2 tabular">
                  {isCommission ? <><span className="text-xl font-semibold">{formatBps(p.commissionBps ?? 0)}</span><span className="text-sm text-ink-3"> per sale · no monthly fee</span></>
                    : price === null ? <span className="text-xl font-semibold">Custom</span> : <><span className="text-xl font-semibold">{formatMoney(price, p.currency)}</span><span className="text-sm text-ink-3"> / {iv === 'MONTHLY' ? 'mo' : 'yr'}</span></>}
                </p>
                <ul className="mt-3 flex-1 space-y-1 text-[13px] text-ink-2">{planBullets(p).slice(0, 5).map((b) => <li key={b}>• {b}</li>)}</ul>
                <div className="mt-4">
                  {current ? <Badge tone="brand">Current plan</Badge>
                    : pending ? <Badge tone="info">Starts {date(sub!.pendingChange!.effectiveAt)}</Badge>
                    : price === null ? <ButtonLink href={`/contact?plan=${p.code}`} size="sm" variant="secondary" className="w-full">Contact sales</ButtonLink>
                    : <Button size="sm" variant="secondary" className="w-full" loading={busy === `plan-${p.code}`} disabled={!!busy} onClick={() => void choose(p)}>{verb} to {p.name}</Button>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader title="Invoices" />
        {invoices.error ? <div className="p-5"><ErrorState message={invoices.error} onRetry={invoices.reload} /></div>
          : !invoices.data ? <PageLoading />
          : invoices.data.length === 0 ? <EmptyState title="No invoices yet">Invoices appear here when a trial ends, a plan renews or you upgrade.</EmptyState>
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3">
                  <tr className="border-b border-line"><th className="px-5 py-2.5 font-medium">Invoice</th><th className="px-5 py-2.5 font-medium">For</th><th className="px-5 py-2.5 font-medium">Status</th><th className="px-5 py-2.5 text-right font-medium">Amount</th><th className="px-5 py-2.5 text-right font-medium">Issued</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {invoices.data.map((inv) => (
                    <tr key={inv.id}>
                      <td className="px-5 py-3 font-mono text-[12px]">{inv.number}</td>
                      <td className="px-5 py-3 text-ink-2">{inv.plan.name} · {KIND[inv.kind]}</td>
                      <td className="px-5 py-3"><Badge tone={INVOICE_STATUS[inv.status][1]}>{INVOICE_STATUS[inv.status][0]}</Badge></td>
                      <td className="px-5 py-3 text-right tabular">{formatMoney(inv.amountMinor, inv.currency)}</td>
                      <td className="px-5 py-3 text-right text-ink-3">{date(inv.dueAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </div>
  );
}

function describeSub(sub: NonNullable<BillingOverview['subscription']>) {
  const per = sub.interval === 'MONTHLY' ? 'month' : 'year';
  const price = sub.interval === 'MONTHLY' ? sub.plan.monthlyPriceMinor : sub.plan.annualPriceMinor;
  const priceText = sub.plan.pricingModel === 'COMMISSION'
    ? `${formatBps(sub.plan.commissionBps ?? 0)} of each verified sale, no monthly fee`
    : price === null ? 'Custom pricing' : `${formatMoney(price, sub.plan.currency)} / ${per}`;
  switch (sub.status) {
    case 'TRIALING': return `${priceText} after your trial · trial ends ${date(sub.trialEndsAt ?? sub.currentPeriodEnd)} (${sub.daysLeft} day${sub.daysLeft === 1 ? '' : 's'} left)`;
    case 'ACTIVE': return `${priceText} · ${sub.cancelAtPeriodEnd ? 'ends' : 'renews'} ${date(sub.currentPeriodEnd)}`;
    case 'PAST_DUE': return `${priceText} · payment due${sub.accessEndsAt ? ` · access continues until ${date(sub.accessEndsAt)}` : ''}`;
    case 'EXPIRED': return `Ended ${sub.endedAt ? date(sub.endedAt) : ''}. Your data is kept. Choose a plan to continue selling.`;
    case 'CANCELLED': return `Cancelled ${sub.endedAt ? date(sub.endedAt) : ''}. Choose a plan to start again.`;
    default: return '';
  }
}

function Usage({ label, used, limit, hint }: { label: string; used: number; limit: number | null; hint?: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink-2">{label}{hint && <span className="text-[12px] text-ink-3"> · {hint}</span>}</span>
        <span className="tabular text-ink">{used} / {limit === null ? 'Unlimited' : limit}</span>
      </div>
      {limit !== null && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label={label}>
          <div className={cx('h-full rounded-full', pct >= 100 ? 'bg-warn' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Explains which commission (if any) applies to this seller's sales right now. */
function CommissionNote({ o }: { o: BillingOverview }) {
  const c = o.commission;
  if (!c) return null;
  const text =
    c.source === 'trial' ? (c.pricingModel === 'COMMISSION'
      ? 'No commission during your free trial. Commission starts when the trial ends.'
      : 'No commission is charged on your sales.')
    : c.bps === 0 ? 'No commission is charged on your sales.'
    : c.source === 'seller_override' ? `Your agreed commission rate is ${formatBps(c.bps)} of each verified sale.`
    : `LiveSell commission: ${formatBps(c.bps)} of each verified sale. Never charged on refunded amounts.`;
  return <p className="rounded-lg bg-sunken px-3 py-2 text-sm text-ink-2">{text}</p>;
}
