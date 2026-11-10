'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import { formatBps, formatMoney, toMinor } from '@/lib/money';
import type { Interval, Plan } from '@/lib/types';
import { planBullets } from './plan-features';
import { Alert, Button, ButtonLink, Skeleton, cx } from './ui';

export function IntervalToggle({ value, onChange }: { value: Interval; onChange: (v: Interval) => void }) {
  return (
    <div role="radiogroup" aria-label="Billing interval" className="inline-flex rounded-full border border-line bg-surface p-1">
      {(['MONTHLY', 'ANNUAL'] as const).map((i) => (
        <button
          key={i} role="radio" aria-checked={value === i} onClick={() => onChange(i)}
          className={cx('rounded-full px-4 py-1.5 text-sm font-medium transition-colors', value === i ? 'bg-ink text-white' : 'text-ink-2 hover:text-ink')}
        >
          {i === 'MONTHLY' ? 'Monthly' : 'Annual'}
        </button>
      ))}
    </div>
  );
}

/** Savings of annual vs 12× monthly, in whole months (integer arithmetic). */
export function annualSavingMonths(plan: Plan): number {
  if (!plan.monthlyPriceMinor || !plan.annualPriceMinor) return 0;
  const m = toMinor(plan.monthlyPriceMinor);
  if (m === 0n) return 0;
  const saved = m * 12n - toMinor(plan.annualPriceMinor);
  return saved > 0n ? Number(saved / m) : 0;
}

/** Browser-side plan loading with loading / error / retry states. */
export function PricingLive() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => {
    setError(false);
    fetch(`${API_URL}/api/v1/plans`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setPlans)
      .catch(() => setError(true));
  }, []);
  useEffect(load, [load]);
  if (error) {
    return (
      <Alert tone="bad" title="Pricing is temporarily unavailable" className="mx-auto max-w-xl" action={<Button size="sm" variant="secondary" onClick={load}>Try again</Button>}>
        We couldn&apos;t load our plans just now.
      </Alert>
    );
  }
  if (!plans) return <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-96 rounded-[var(--radius-card)]" />)}</div>;
  return <PricingTable plans={plans} />;
}

export function PricingTable({ plans }: { plans: Plan[] }) {
  const [interval, setInterval] = useState<Interval>('MONTHLY');
  const featured = 'PROFESSIONAL';
  const subscription = plans.filter((p) => p.pricingModel !== 'COMMISSION');
  const commission = plans.filter((p) => p.pricingModel === 'COMMISSION');
  return (
    <div>
      <div className="mb-8 flex justify-center"><IntervalToggle value={interval} onChange={setInterval} /></div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {subscription.map((p) => {
          const price = interval === 'MONTHLY' ? p.monthlyPriceMinor : p.annualPriceMinor;
          const custom = price === null;
          const saving = annualSavingMonths(p);
          return (
            <div
              key={p.id}
              className={cx(
                'flex flex-col rounded-[var(--radius-card)] border bg-surface p-6 shadow-[var(--shadow-card)]',
                p.code === featured ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line',
              )}
            >
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{p.name}</h2>
                {p.code === featured && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">Most popular</span>}
              </div>
              {p.description && <p className="mt-1 text-sm text-ink-3">{p.description}</p>}
              <div className="mt-5 min-h-16">
                {custom ? (
                  <p className="text-3xl font-semibold tracking-tight">Custom</p>
                ) : (
                  <p className="tabular">
                    <span className="text-3xl font-semibold tracking-tight">{formatMoney(price, p.currency)}</span>
                    <span className="text-sm text-ink-3"> / {interval === 'MONTHLY' ? 'month' : 'year'}</span>
                  </p>
                )}
                {!custom && interval === 'ANNUAL' && saving > 0 && <p className="mt-1 text-[13px] font-medium text-brand-700">{saving} months free</p>}
              </div>
              <ul className="mt-4 flex-1 space-y-2 text-sm text-ink-2">
                {planBullets(p).map((b) => (
                  <li key={b} className="flex gap-2">
                    <svg aria-hidden viewBox="0 0 24 24" className="mt-0.5 size-4 shrink-0 text-brand-700" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                    {b}
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                {custom ? (
                  <ButtonLink href={`/contact?plan=${p.code}`} variant="secondary" className="w-full">Contact sales</ButtonLink>
                ) : (
                  <ButtonLink href={`/register?plan=${p.code}`} variant={p.code === featured ? 'primary' : 'secondary'} className="w-full">
                    Start {p.trialDays}-day free trial
                  </ButtonLink>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {commission.map((p) => <CommissionCard key={p.id} plan={p} />)}
    </div>
  );
}

/** The commission-based alternative: no fixed fee, a share of each verified sale. */
export function CommissionCard({ plan }: { plan: Plan }) {
  return (
    <div className="mt-6 grid gap-6 rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-[var(--shadow-card)] md:grid-cols-[1fr_auto] md:items-center">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">{plan.name}</h2>
          <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-ink-2">Commission-based</span>
        </div>
        <p className="mt-1 text-sm text-ink-2">{plan.description ?? 'No monthly fee. Pay only when you sell.'}</p>
        <p className="mt-3 tabular">
          <span className="text-3xl font-semibold tracking-tight">{formatBps(plan.commissionBps ?? 0)}</span>
          <span className="text-sm text-ink-3"> of each verified sale · ₦0 / month</span>
        </p>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2">
          {planBullets(plan).map((b) => <li key={b}>• {b}</li>)}
        </ul>
        <p className="mt-3 text-[13px] text-ink-3">No commission during your {plan.trialDays}-day free trial. Commission is never charged on refunded amounts.</p>
      </div>
      <ButtonLink href={`/register?plan=${plan.code}`} variant="secondary" className="w-full md:w-auto">Start free, pay as you sell</ButtonLink>
    </div>
  );
}
