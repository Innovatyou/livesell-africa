'use client';

import { useEffect, useState } from 'react';
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, EmptyState, ErrorState, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money';
import type { AnalyticsReport, ReportSchedules } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Pure: 7 × 24 grid of order counts from the sparse cells the API returns, with the busiest value. */
export function patternGrid(cells: NonNullable<AnalyticsReport['patterns']>) {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  let max = 0;
  for (const c of cells) {
    grid[c.weekday - 1][c.hour] += c.orders;
    max = Math.max(max, grid[c.weekday - 1][c.hour]);
  }
  return { grid, max };
}

/** When orders come in (advanced tier): darker = more orders. Helps pick live-session times. */
export function OrderPatterns({ cells }: { cells: NonNullable<AnalyticsReport['patterns']> }) {
  const { grid, max } = patternGrid(cells);
  const busiest = cells.length ? [...cells].sort((a, b) => b.orders - a.orders)[0] : null;
  return (
    <Card>
      <CardHeader title="When orders come in" description={busiest ? `Busiest: ${DAYS[busiest.weekday - 1]} around ${String(busiest.hour).padStart(2, '0')}:00 (Lagos). Plan live sessions for when your buyers are around.` : 'By weekday and hour (Lagos).'} />
      {cells.length === 0 ? <EmptyState title="No orders in this period" /> : (
        <div className="overflow-x-auto p-4">
          <table className="border-separate" style={{ borderSpacing: 2 }} aria-label="Orders by weekday and hour">
            <thead><tr><th className="w-10" />{Array.from({ length: 24 }, (_, h) => <th key={h} className="w-5 text-[10px] font-normal text-ink-3">{h % 3 === 0 ? h : ''}</th>)}</tr></thead>
            <tbody>
              {grid.map((row, d) => (
                <tr key={d}>
                  <th className="pr-2 text-right text-[12px] font-normal text-ink-3">{DAYS[d]}</th>
                  {row.map((n, h) => (
                    <td key={h} title={`${DAYS[d]} ${String(h).padStart(2, '0')}:00 — ${n} order${n === 1 ? '' : 's'}`} className="h-5 w-5 rounded-[3px]"
                      style={{ background: n === 0 ? 'var(--color-sunken)' : `color-mix(in srgb, var(--color-brand-600) ${Math.round(20 + (80 * n) / max)}%, transparent)` }} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function TopCustomers({ rows, currency }: { rows: NonNullable<AnalyticsReport['topCustomers']>; currency: string }) {
  return (
    <Card>
      <CardHeader title="Top customers" description="By paid spend in this period. Open Customers for contact details." />
      {rows.length === 0 ? <EmptyState title="No paid sales in this period" /> : (
        <ol className="divide-y divide-line">
          {rows.map((c, i) => (
            <li key={c.customerId} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
              <span className="min-w-0"><span className="mr-2 text-ink-3 tabular">{i + 1}.</span><a href={`/customers/${c.customerId}`} className="font-medium hover:text-brand-700">{c.name}</a>{c.newInRange && <Badge className="ml-2" tone="info">New</Badge>}</span>
              <span className="shrink-0 tabular"><span className="text-ink-2">{c.paidOrders} order{c.paidOrders === 1 ? '' : 's'}</span><span className="ml-3 font-medium">{formatMoney(c.spendMinor, currency)}</span></span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** Weekly / monthly email reports (advanced tier). */
export function ReportSchedulesCard() {
  const { can } = useAuth();
  const res = useApi<ReportSchedules>('/analytics/schedules');
  const canEdit = can('store:manage');
  const [state, setState] = useState<Record<'WEEKLY' | 'MONTHLY', { on: boolean; ids: string[] }>>({ WEEKLY: { on: false, ids: [] }, MONTHLY: { on: false, ids: [] } });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (!res.data) return;
    const get = (f: 'WEEKLY' | 'MONTHLY') => {
      const s = res.data!.schedules.find((x) => x.frequency === f);
      return { on: !!s?.isActive, ids: s?.recipientUserIds ?? [] };
    };
    setState({ WEEKLY: get('WEEKLY'), MONTHLY: get('MONTHLY') });
  }, [res.data]);

  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (!res.data) return <Card><PageLoading /></Card>;
  if (!res.data.available) {
    return <Card><CardHeader title="Email reports" /><EmptyState title="Weekly and monthly email reports are on Business, Enterprise and Pay as you sell" action={can('billing:manage') ? <ButtonLink href="/settings/billing" size="sm" variant="secondary">See plans</ButtonLink> : undefined} /></Card>;
  }
  const people = res.data.recipients;

  async function save(f: 'WEEKLY' | 'MONTHLY') {
    setBusy(f);
    setMsg(null);
    try {
      res.setData(await api<ReportSchedules>('/analytics/schedules', { method: 'PUT', body: { frequency: f, recipientUserIds: state[f].ids, isActive: state[f].on } }));
      setMsg({ tone: 'good', text: state[f].on ? `${f === 'WEEKLY' ? 'Weekly' : 'Monthly'} report saved.` : 'Report switched off.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader title="Email reports" description="A summary by email after each week (Monday morning) or month (the 1st), to team members who can view analytics." />
      <div className="space-y-4 p-5 text-sm">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {(['WEEKLY', 'MONTHLY'] as const).map((f) => (
          <fieldset key={f} disabled={!canEdit} className="space-y-2 rounded-lg border border-line p-4">
            <legend className="px-1 font-medium">{f === 'WEEKLY' ? 'Weekly report' : 'Monthly report'}</legend>
            <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={state[f].on} onChange={(e) => setState({ ...state, [f]: { ...state[f], on: e.target.checked } })} /> Send it</label>
            {state[f].on && <div className="grid gap-1 sm:grid-cols-2">
              {people.map((p) => (
                <label key={p.id} className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={state[f].ids.includes(p.id)}
                  onChange={(e) => setState({ ...state, [f]: { ...state[f], ids: e.target.checked ? [...state[f].ids, p.id] : state[f].ids.filter((x) => x !== p.id) } })} />
                  <span>{p.fullName} <span className="text-ink-3">{p.email}</span></span></label>
              ))}
            </div>}
            {canEdit && <Button size="sm" variant="secondary" loading={busy === f} disabled={state[f].on && state[f].ids.length === 0} onClick={() => void save(f)}>Save</Button>}
          </fieldset>
        ))}
        {!canEdit && <p className="text-[13px] text-ink-3">Ask the owner or someone who manages the store to change who receives reports.</p>}
      </div>
    </Card>
  );
}
