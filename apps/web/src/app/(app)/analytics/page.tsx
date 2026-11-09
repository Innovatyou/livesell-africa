'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { OrderPatterns, ReportSchedulesCard, TopCustomers } from '@/components/analytics-advanced';
import { SalesChart } from '@/components/sales-chart';
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageLoading, Select, cx } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { changeLabel, changeTone, lagosDay, Preset, PRESETS, presetRange, rate } from '@/lib/analytics-labels';
import { useAuth } from '@/lib/auth';
import { downloadCsv, downloadFile } from '@/lib/download';
import { formatCount, formatMoney } from '@/lib/money';
import type { AnalyticsReport, Change, SalesChannel, SalesChart as Chart } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const CSV: Array<[string, string]> = [['summary', 'Summary'], ['daily', 'Sales over time'], ['channels', 'Channels'], ['sessions', 'Live sessions'], ['products', 'Top products']];
const CSV_ADVANCED: Array<[string, string]> = [['patterns', 'Weekday × hour'], ['customers', 'Top customers']];
const day = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${s}T00:00:00Z`));
const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' }).format(new Date(s));

/** MASTER-SPEC §19 live selling analytics, plus channel comparison and CSV/PDF reports. Real data only. */
export default function AnalyticsPage() {
  const { can } = useAuth();
  const allowed = can('reports:read');
  const [preset, setPreset] = useState<Preset | 'custom'>('30d');
  const [custom, setCustom] = useState(() => presetRange('30d'));
  const [channelId, setChannelId] = useState('');
  const [csv, setCsv] = useState('summary');
  const [busy, setBusy] = useState<'csv' | 'pdf' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const range = preset === 'custom' ? custom : presetRange(preset);
  const today = lagosDay(new Date());
  const customError = preset === 'custom' && (!custom.from || !custom.to ? 'Choose both dates' : custom.from > custom.to ? 'The start is after the end' : custom.to > today ? 'The end can’t be in the future' : null);
  const qs = useMemo(() => {
    const p = new URLSearchParams({ from: range.from, to: range.to });
    if (channelId) p.set('channelId', channelId);
    return p.toString();
  }, [range.from, range.to, channelId]);
  const report = useApi<AnalyticsReport>(allowed && !customError ? `/analytics?${qs}` : null);
  const channels = useApi<SalesChannel[]>(allowed ? '/sales-channels' : null);

  if (!allowed) return <Card><EmptyState title="Your role can’t view analytics" /></Card>;

  async function exportCsv() {
    setBusy('csv');
    setMsg(null);
    try {
      await downloadCsv(`/analytics/export?${qs}&report=${csv}`, `livesell-${csv}-${range.from}-to-${range.to}.csv`);
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function exportPdf() {
    setBusy('pdf');
    setMsg(null);
    try {
      await downloadFile(`/analytics/report.pdf?${qs}`, `livesell-report-${range.from}-to-${range.to}.pdf`);
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const gated = report.errorCode === 'FEATURE_NOT_IN_PLAN' && !/days at a time/.test(report.error ?? '');
  const longRange = report.errorCode === 'FEATURE_NOT_IN_PLAN' && !gated;
  const r = report.data;

  return (
    <div className="space-y-6">
      <PageHeader title="Analytics" description="Sales, live sessions and channels for any period, compared with the period before. Paid means the payment was verified."
        action={!gated && <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="CSV report" value={csv} onChange={(e) => setCsv(e.target.value)} className="h-9 w-auto">{[...CSV, ...(r?.tier === 'advanced' ? CSV_ADVANCED : [])].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
          <Button size="sm" variant="secondary" loading={busy === 'csv'} disabled={!r} onClick={() => void exportCsv()}>Export CSV</Button>
          {(!r || r.limits.pdf) && <Button size="sm" variant="secondary" loading={busy === 'pdf'} disabled={!r} onClick={() => void exportPdf()}>Download PDF</Button>}
        </div>} />
      {msg && <Alert tone="bad">{msg}</Alert>}

      {gated ? (
        <Card><EmptyState title="Analytics is on the Professional plan and above" action={can('billing:manage') ? <ButtonLink href="/settings/billing">See plans</ButtonLink> : undefined}>
          Your dashboard still shows today’s and this month’s sales. Upgrade to compare periods, channels and live sessions and to download reports.
        </EmptyState></Card>
      ) : <>
        <Card className="space-y-3 p-4">
          <div role="tablist" aria-label="Period" className="flex gap-1 overflow-x-auto pb-1">
            {[...PRESETS, ['custom', 'Custom'] as [string, string]].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={preset === k} onClick={() => setPreset(k as Preset | 'custom')}
                className={cx('whitespace-nowrap rounded-full border px-3 py-1.5 text-sm', preset === k ? 'border-brand-500 bg-brand-50 font-medium text-brand-800' : 'border-line bg-surface text-ink-2 hover:text-ink')}>{l}</button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1.4fr]">
            {preset === 'custom' ? <>
              <Field label="From" error={customError || undefined}>{(p) => <Input {...p} type="date" max={today} value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />}</Field>
              <Field label="To">{(p) => <Input {...p} type="date" max={today} value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />}</Field>
            </> : <p className="self-end pb-2 text-sm text-ink-2 sm:col-span-2">{day(range.from)} – {day(range.to)}{r ? ` · compared with ${day(r.previousRange.from)} – ${day(r.previousRange.to)}` : ''}</p>}
            <Field label="Sales channel">{(p) => (
              <Select {...p} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                <option value="">All channels</option>
                {(channels.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            )}</Field>
          </div>
        </Card>

        {customError ? null : longRange ? <Alert tone="warn">{report.error}</Alert>
          : report.error ? <ErrorState message={report.error} onRetry={report.reload} /> : !r ? <PageLoading /> : <>
            {r.tier === 'standard' && <Alert tone="info" action={can('billing:manage') ? <ButtonLink href="/settings/billing" size="sm" variant="secondary">See plans</ButtonLink> : undefined}>
              Your plan covers up to {r.limits.maxDays} days at a time. Business, Enterprise and Pay as you sell add a year of history, PDF reports, order-time patterns, top customers and emailed reports.
            </Alert>}
            <Report r={r} />
            {r.patterns && <OrderPatterns cells={r.patterns} />}
            {r.topCustomers && <TopCustomers rows={r.topCustomers} currency={r.currency} />}
            <ReportSchedulesCard />
          </>}
      </>}
    </div>
  );
}

function Report({ r }: { r: AnalyticsReport }) {
  const o = r.overview;
  const c = r.comparison;
  const money = (v: string) => formatMoney(v, r.currency);
  const chart: Chart = {
    period: r.range.bucket === 'day' ? 'daily' : r.range.bucket === 'week' ? 'weekly' : 'monthly', currency: r.currency, timezone: r.timezone,
    totalMinor: o.grossSalesMinor, points: r.series.map((p) => ({ label: p.label, amountMinor: p.grossSalesMinor, payments: p.paidOrders })),
  };
  if (o.orders === 0 && c.orders.previous === 0) {
    return <Card><EmptyState title="No orders in this period">Orders from your storefront, WhatsApp, live sessions and manual entry appear here once they are placed.</EmptyState></Card>;
  }
  return (
    <>
      <section aria-label="Summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Gross sales" value={money(o.grossSalesMinor)} change={c.grossSalesMinor} />
        <Kpi label="Net sales" value={money(o.netSalesMinor)} change={c.netSalesMinor} hint={o.refundsMinor !== '0' ? `${money(o.refundsMinor)} refunded` : undefined} />
        <Kpi label="Orders" value={formatCount(o.orders)} change={c.orders} hint={`${o.paidOrders} paid · ${o.awaitingPayment} awaiting payment`} />
        <Kpi label="Average order value" value={money(o.averageOrderValueMinor)} change={c.averageOrderValueMinor} />
        <Kpi label="Payment completion" value={rate(o.paymentCompletionBps)} hint={`Before: ${rate(c.paymentCompletionBps.previous)}`} />
        <Kpi label="Cancellation rate" value={rate(o.cancellationBps)} hint={`${o.cancelledOrders} cancelled · before: ${rate(c.cancellationBps.previous)}`} />
        <Kpi label="Units sold" value={formatCount(o.unitsSold)} change={c.unitsSold} />
        <Kpi label="New customers" value={formatCount(o.newCustomers)} change={c.newCustomers} hint={`${o.buyers} buyers · ${o.repeatBuyers} repeat (${rate(o.repeatPurchaseBps)})`} />
      </section>

      <Card>
        <CardHeader title="Paid sales over time" description={`Per ${r.range.bucket}, by the day orders were placed (${r.timezone}).`} />
        <div className="p-4"><SalesChart data={chart} /></div>
      </Card>

      <Card>
        <CardHeader title="Sales channels" description={r.channel ? 'All channels are shown here for comparison; the summary above is filtered.' : 'Where your orders came from.'} />
        {r.channels.length === 0 ? <EmptyState title="No orders in this period" /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3"><tr className="border-b border-line">
                <th className="px-5 py-2.5 font-medium">Channel</th><th className="px-3 py-2.5 text-right font-medium">Orders</th><th className="px-3 py-2.5 text-right font-medium">Paid</th>
                <th className="px-3 py-2.5 text-right font-medium">Gross sales</th><th className="px-3 py-2.5 text-right font-medium">Avg. order</th>
                <th className="px-3 py-2.5 text-right font-medium">Completion</th><th className="px-3 py-2.5 text-right font-medium">Cancelled</th><th className="px-5 py-2.5 text-right font-medium">New customers</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {r.channels.map((ch) => (
                  <tr key={ch.channelId ?? 'none'} className={cx(r.channel && r.channel.id === ch.channelId && 'bg-brand-50')}>
                    <td className="px-5 py-3 font-medium">{ch.name}</td>
                    <td className="px-3 py-3 text-right tabular">{ch.orders}</td><td className="px-3 py-3 text-right tabular">{ch.paidOrders}</td>
                    <td className="px-3 py-3 text-right tabular">{money(ch.grossSalesMinor)}</td><td className="px-3 py-3 text-right tabular">{money(ch.averageOrderValueMinor)}</td>
                    <td className="px-3 py-3 text-right tabular">{rate(ch.paymentCompletionBps)}</td><td className="px-3 py-3 text-right tabular">{rate(ch.cancellationBps)}</td>
                    <td className="px-5 py-3 text-right tabular">{ch.newCustomers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Live sessions" description="Sessions started in this period with all their orders. Conversion appears only when you recorded peak viewers — LiveSell never estimates viewer numbers." />
        {r.sessions.length === 0 ? <EmptyState title="No live sessions in this period" action={<ButtonLink href="/live" size="sm" variant="secondary">Go to live selling</ButtonLink>} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3"><tr className="border-b border-line">
                <th className="px-5 py-2.5 font-medium">Session</th><th className="px-3 py-2.5 text-right font-medium">Orders</th><th className="px-3 py-2.5 text-right font-medium">Paid</th>
                <th className="px-3 py-2.5 text-right font-medium">Gross sales</th><th className="px-3 py-2.5 text-right font-medium">Units</th>
                <th className="px-3 py-2.5 text-right font-medium">Avg. order</th><th className="px-3 py-2.5 text-right font-medium">Completion</th><th className="px-5 py-2.5 text-right font-medium">Conversion</th>
              </tr></thead>
              <tbody className="divide-y divide-line">
                {r.sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="px-5 py-3"><Link href={`/live/${s.id}`} className="font-medium hover:text-brand-700">{s.title}</Link><p className="text-[12px] text-ink-3">{s.channel} · {when(s.startedAt)}{s.durationMinutes !== null ? ` · ${s.durationMinutes} min` : ' · live now'}</p></td>
                    <td className="px-3 py-3 text-right tabular">{s.orders}</td><td className="px-3 py-3 text-right tabular">{s.paidOrders}</td>
                    <td className="px-3 py-3 text-right tabular">{money(s.grossSalesMinor)}</td><td className="px-3 py-3 text-right tabular">{s.unitsSold}</td>
                    <td className="px-3 py-3 text-right tabular">{money(s.averageOrderValueMinor)}</td><td className="px-3 py-3 text-right tabular">{rate(s.paymentCompletionBps)}</td>
                    <td className="px-5 py-3 text-right">{s.conversionBps === null ? <span className="text-[12px] text-ink-3">No viewer data</span> : <span title={`${s.buyers} buyers of ${s.peakViewers} peak viewers (recorded by you)`} className="tabular">{rate(s.conversionBps)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Top products" description="By units sold in paid orders." />
        {r.topProducts.length === 0 ? <EmptyState title="No paid sales in this period" /> : (
          <ol className="divide-y divide-line">
            {r.topProducts.map((p, i) => (
              <li key={p.productId} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <span className="min-w-0"><span className="mr-2 text-ink-3 tabular">{i + 1}.</span><span className="font-mono text-[12px] text-ink-3">{p.productCode}</span> <span className="font-medium">{p.name}</span></span>
                <span className="shrink-0 text-right"><span className="tabular">{p.unitsSold} sold</span><span className="ml-3 tabular text-ink-2">{money(p.revenueMinor)}</span></span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}

function Kpi({ label, value, change, hint }: { label: string; value: string; change?: Change; hint?: string }) {
  const tone = change ? changeTone(change.change) : 'neutral';
  return (
    <Card className="space-y-1 p-4">
      <p className="text-[13px] text-ink-3">{label}</p>
      <p className="text-xl font-semibold tabular">{value}</p>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
        {change && <Badge tone={tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : 'neutral'}>{changeLabel(change.changeBps, change.change)}</Badge>}
        {hint && <span>{hint}</span>}
      </div>
    </Card>
  );
}
