'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatBps, formatMoney } from '@/lib/money';
import type { CommissionSummary } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const date = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' }).format(new Date(s));

/**
 * Commission owed to LiveSell (Pay as you sell, or a negotiated rate). Split payments are settled automatically;
 * sales collected directly (own payment account, bank transfer) are invoiced at the start of each month.
 */
export function CommissionCard({ paymentCollectionEnabled }: { paymentCollectionEnabled: boolean }) {
  const res = useApi<CommissionSummary>('/billing/commission');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (!res.data) return <Card><PageLoading /></Card>;
  const c = res.data;
  const charging = !!c.rate && c.rate.bps > 0;
  // Nothing to show for stores that have never owed commission and aren't on a commission rate.
  if (!charging && c.invoices.length === 0 && c.unbilledMinor === '0') return null;
  const money = (v: string) => formatMoney(v, c.currency);

  async function pay(id: string) {
    setBusy(id);
    setMsg(null);
    try {
      const r = await api<{ checkoutUrl: string }>(`/billing/invoices/${id}/pay`, { method: 'POST', body: {} });
      window.location.assign(r.checkoutUrl);
    } catch (e) {
      setMsg(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader title="Commission" description={c.rate ? (c.rate.source === 'trial' ? 'No commission during your free trial.' : `${formatBps(c.rate.bps)} of each verified sale.`) : undefined} />
      <div className="space-y-4 p-5 text-sm">
        {c.writesBlocked && <Alert tone="bad" title="Commission invoice overdue">Changes to your store are paused until the overdue invoice below is paid. Your data and storefront stay visible.</Alert>}
        {msg && <Alert tone="bad">{msg}</Alert>}
        <dl className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-line p-3"><dt className="text-[13px] text-ink-3">This month (collected by you)</dt><dd className="text-lg font-semibold tabular">{money(c.thisMonthMinor)}</dd></div>
          <div className="rounded-lg border border-line p-3"><dt className="text-[13px] text-ink-3">Not yet invoiced</dt><dd className="text-lg font-semibold tabular">{money(c.unbilledMinor)}</dd></div>
          <div className="rounded-lg border border-line p-3"><dt className="text-[13px] text-ink-3">Taken at source this month</dt><dd className="text-lg font-semibold tabular">{money(c.collectedAtSourceThisMonthMinor)}</dd></div>
        </dl>
        <p className="text-[13px] text-ink-3">
          Payments split through LiveSell settle the commission automatically. For money you receive yourself (your own payment account or bank transfer), LiveSell sends one invoice on {date(c.nextInvoiceOn)} for the month before, due within {c.dueDays} days.
          Amounts under {money(c.minInvoiceMinor)} carry over. An invoice still unpaid {c.graceDays} days after its due date pauses changes to your store until it is paid. Refunds reduce the commission.
        </p>
        {c.invoices.length === 0 ? <EmptyState title="No commission invoices yet" /> : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {c.invoices.map((i) => (
              <li key={i.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">{i.number} <span className="font-normal text-ink-3">· {i.description}</span></p>
                  <p className="text-[13px] text-ink-3">{i.status === 'PAID' && i.paidAt ? `Paid ${date(i.paidAt)}` : `Due ${date(i.dueAt)}`}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular font-semibold">{money(i.amountMinor)}</span>
                  <Badge tone={i.status === 'PAID' ? 'good' : i.overdue ? 'bad' : i.status === 'OPEN' ? 'warn' : 'neutral'}>{i.status === 'PAID' ? 'Paid' : i.overdue ? 'Overdue' : i.status === 'OPEN' ? 'Open' : i.status.toLowerCase()}</Badge>
                  {i.status === 'OPEN' && paymentCollectionEnabled && <Button size="sm" loading={busy === i.id} disabled={!!busy} onClick={() => void pay(i.id)}>Pay now</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {!paymentCollectionEnabled && c.invoices.some((i) => i.status === 'OPEN') && <p className="text-[13px] text-ink-3">Online payment for LiveSell invoices is being connected; your access isn’t paused while it is.</p>}
      </div>
    </Card>
  );
}
