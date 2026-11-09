'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { planBullets } from '@/components/plan-features';
import { Badge, Button, ErrorState, Field, Input, PageLoading } from '@/components/ui';
import { adminCall, Section, useAction, useAdmin, useIsAdmin } from '@/components/admin-ui';
import { formatBps, formatMoney, koboToNairaInput, nairaToKobo } from '@/lib/money';
import type { Plan } from '@/lib/types';

type AdminPlan = Plan & { isActive: boolean; isPublic: boolean; trialDays: number; _count?: { subscriptions: number }; subscribers?: number };

/** Subscription plans: prices, commission rate, trial, visibility. Limits and features follow the seeded structure. */
export default function AdminPlans() {
  const isAdmin = useIsAdmin();
  const res = useAdmin<AdminPlan[]>('/admin/plans');
  const act = useAction();
  const [edit, setEdit] = useState<string | null>(null);
  const [f, setF] = useState({ monthly: '', annual: '', bps: '', trial: '' });
  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (!res.data) return <PageLoading />;

  function open(p: AdminPlan) {
    setEdit(p.id);
    setF({ monthly: p.monthlyPriceMinor === null ? '' : koboToNairaInput(p.monthlyPriceMinor), annual: p.annualPriceMinor === null ? '' : koboToNairaInput(p.annualPriceMinor), bps: p.commissionBps === null ? '' : String(p.commissionBps), trial: String(p.trialDays) });
  }
  async function save(p: AdminPlan) {
    const monthly = f.monthly.trim() === '' ? null : nairaToKobo(f.monthly);
    const annual = f.annual.trim() === '' ? null : nairaToKobo(f.annual);
    if ((f.monthly.trim() && monthly === null) || (f.annual.trim() && annual === null)) throw new Error('Enter prices in naira, e.g. 12,000');
    const body: Record<string, unknown> = { monthlyPriceMinor: monthly, annualPriceMinor: annual, trialDays: Number(f.trial) };
    if (p.pricingModel === 'COMMISSION') body.commissionBps = Number(f.bps);
    await adminCall(`/admin/plans/${p.id}`, 'PATCH', body);
    setEdit(null);
    await res.reload();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Plans" description="Price changes apply to invoices issued from now on. Hide or switch off a plan instead of deleting it." />
      {act.note}
      {res.data.map((p) => (
        <Section key={p.id} title={p.name} description={p.pricingModel === 'COMMISSION' ? `Commission plan · ${formatBps(p.commissionBps ?? 0)} per verified sale` : `${p.monthlyPriceMinor === null ? 'Custom price' : `${formatMoney(p.monthlyPriceMinor)}/month`}`}
          action={<div className="flex items-center gap-2">
            <Badge tone={p.isActive ? 'good' : 'neutral'}>{p.isActive ? 'Active' : 'Off'}</Badge>{!p.isPublic && <Badge>Hidden</Badge>}
            {isAdmin && edit !== p.id && <Button size="sm" variant="secondary" onClick={() => open(p)}>Edit</Button>}
          </div>}>
          <div className="space-y-3 px-5 pb-5 text-sm">
            <p className="text-ink-2">{planBullets(p).join(' · ')}</p>
            {edit === p.id && (
              <div className="space-y-3 rounded-lg border border-line p-3">
                <div className="grid gap-3 sm:grid-cols-4">
                  <Field label="Monthly (₦)" hint="Blank = custom">{(x) => <Input {...x} inputMode="decimal" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} />}</Field>
                  <Field label="Annual (₦)">{(x) => <Input {...x} inputMode="decimal" value={f.annual} onChange={(e) => setF({ ...f, annual: e.target.value })} />}</Field>
                  <Field label="Trial days">{(x) => <Input {...x} inputMode="numeric" value={f.trial} onChange={(e) => setF({ ...f, trial: e.target.value })} />}</Field>
                  {p.pricingModel === 'COMMISSION' && <Field label="Commission (bps)" hint="300 = 3%">{(x) => <Input {...x} inputMode="numeric" value={f.bps} onChange={(e) => setF({ ...f, bps: e.target.value })} />}</Field>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" loading={act.busy === `s-${p.id}`} onClick={() => void act.run(`s-${p.id}`, () => save(p), `${p.name} saved.`)}>Save</Button>
                  <Button size="sm" variant="secondary" loading={act.busy === `a-${p.id}`} onClick={() => void act.run(`a-${p.id}`, async () => { await adminCall(`/admin/plans/${p.id}`, 'PATCH', { isActive: !p.isActive }); await res.reload(); }, 'Saved.')}>{p.isActive ? 'Switch off' : 'Switch on'}</Button>
                  <Button size="sm" variant="secondary" loading={act.busy === `v-${p.id}`} onClick={() => void act.run(`v-${p.id}`, async () => { await adminCall(`/admin/plans/${p.id}`, 'PATCH', { isPublic: !p.isPublic }); await res.reload(); }, 'Saved.')}>{p.isPublic ? 'Hide from pricing page' : 'Show on pricing page'}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        </Section>
      ))}
    </div>
  );
}
