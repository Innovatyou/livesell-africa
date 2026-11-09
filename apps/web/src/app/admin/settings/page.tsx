'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageLoading, Select } from '@/components/ui';
import { adminCall, Pager, Section, useAction, useAdmin, useIsAdmin, when } from '@/components/admin-ui';

interface Setting { key: string; label: string; hint: string; value: unknown }
interface Webhook { id: string; provider: string; eventId: string; eventType: string; signatureValid: boolean; status: string; error: string | null; receivedAt: string }
interface Inquiry { id: string; fullName: string; email: string; phone: string | null; businessName: string; planInterest: string | null; monthlyOrders: string | null; message: string | null; status: string; createdAt: string }

/** Platform settings, payment webhook problems and sales enquiries. */
export default function AdminSettings() {
  const isAdmin = useIsAdmin();
  const settings = useAdmin<Setting[]>('/admin/settings');
  const [hookFilter, setHookFilter] = useState('problems');
  const [page, setPage] = useState(1);
  const hooks = useAdmin<{ items: Webhook[]; total: number }>(`/admin/webhooks?page=${page}${hookFilter === 'problems' ? '&invalidOnly=false&status=FAILED' : hookFilter === 'unsigned' ? '&invalidOnly=true' : ''}`);
  const inquiries = useAdmin<Inquiry[]>('/admin/sales-inquiries?status=NEW');
  const act = useAction();
  const [draft, setDraft] = useState<Record<string, string>>({});

  function parse(v: string): unknown {
    const t = v.trim();
    if (/^\d+$/.test(t)) return Number(t);
    if (/^\d+(\s*,\s*\d+)*$/.test(t)) return t.split(',').map((x) => Number(x.trim()));
    return t;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Settings & system" description="Messaging prices, Veltrix and WhatsApp live on Integrations; plans on Plans." />
      {act.note}
      <Section title="Platform settings" description="Every change is validated and written to the audit log.">
        {settings.error ? <div className="p-5"><ErrorState message={settings.error} onRetry={settings.reload} /></div> : !settings.data ? <PageLoading /> : (
          <ul className="divide-y divide-line text-sm">
            {settings.data.map((s) => {
              const shown = Array.isArray(s.value) ? s.value.join(', ') : s.value === null ? '' : String(s.value);
              const v = draft[s.key] ?? shown;
              return (
                <li key={s.key} className="grid gap-2 px-5 py-3 sm:grid-cols-[1fr_200px_auto] sm:items-end">
                  <div><p className="font-medium">{s.label}</p><p className="text-[12px] text-ink-3"><span className="font-mono">{s.key}</span> · {s.hint}</p></div>
                  <Field label="Value" className="sm:mb-0">{(p) => <Input {...p} disabled={!isAdmin} value={v} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} />}</Field>
                  {isAdmin && <Button size="sm" variant="secondary" disabled={v === shown} loading={act.busy === s.key}
                    onClick={() => void act.run(s.key, async () => { settings.setData(await adminCall<Setting[]>(`/admin/settings/${s.key}`, 'PUT', { value: parse(v) })); setDraft((d) => { const n = { ...d }; delete n[s.key]; return n; }); }, `${s.label} saved.`)}>Save</Button>}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <div id="webhooks">
        <Section title="Payment webhooks" description="Webhooks only ever trigger a server-side verify; a failed or unsigned one never marks anything paid."
          action={<Select aria-label="Filter" value={hookFilter} onChange={(e) => { setHookFilter(e.target.value); setPage(1); }} className="h-9 w-auto"><option value="problems">Failed</option><option value="unsigned">Bad signature</option><option value="all">All</option></Select>}>
          {hooks.error ? <div className="p-5"><ErrorState message={hooks.error} onRetry={hooks.reload} /></div> : !hooks.data ? <PageLoading /> : hooks.data.items.length === 0 ? <EmptyState title="Nothing here" /> : (
            <ul className="divide-y divide-line text-sm">
              {hooks.data.items.map((w) => (
                <li key={w.id} className="flex flex-col gap-1 px-5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <span><span className="font-medium">{w.provider}</span> <span className="text-ink-3">{w.eventType} · {when(w.receivedAt)}</span>{w.error && <span className="block text-[13px] text-bad">{w.error}</span>}</span>
                  <span className="flex gap-2">{!w.signatureValid && <Badge tone="bad">Bad signature</Badge>}<Badge tone={w.status === 'PROCESSED' ? 'good' : w.status === 'FAILED' ? 'bad' : 'neutral'}>{w.status.toLowerCase()}</Badge></span>
                </li>
              ))}
            </ul>
          )}
          {hooks.data && <Pager page={page} total={hooks.data.total} size={25} onPage={setPage} />}
        </Section>
      </div>

      <Section title="New sales enquiries" description="From the “Contact sales” form (Enterprise).">
        {inquiries.error ? <div className="p-5"><ErrorState message={inquiries.error} onRetry={inquiries.reload} /></div> : !inquiries.data ? <PageLoading /> : inquiries.data.length === 0 ? <EmptyState title="No new enquiries" /> : (
          <ul className="divide-y divide-line text-sm">
            {inquiries.data.map((q) => (
              <li key={q.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div><p className="font-medium">{q.businessName} <span className="font-normal text-ink-3">· {q.fullName} · {q.email}{q.phone ? ` · ${q.phone}` : ''}</span></p>
                  <p className="text-[13px] text-ink-3">{[q.planInterest, q.monthlyOrders ? `${q.monthlyOrders} orders/month` : null, when(q.createdAt)].filter(Boolean).join(' · ')}</p>
                  {q.message && <p className="mt-1 text-ink-2">{q.message}</p>}</div>
                {isAdmin && <Button size="sm" variant="secondary" loading={act.busy === q.id} onClick={() => void act.run(q.id, async () => { await adminCall(`/admin/sales-inquiries/${q.id}`, 'PATCH', { status: 'CONTACTED' }); await inquiries.reload(); }, 'Marked as contacted.')}>Mark contacted</Button>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
