'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Badge, Button, Card, EmptyState, ErrorState, PageLoading, Select } from '@/components/ui';
import { adminCall, day, ReasonForm, useAction, useAdmin, useIsAdmin } from '@/components/admin-ui';

interface Row { id: string; status: string; registeredName: string; registrationType: string; registrationNumber: string; createdAt: string; tenant: { id: string; slug: string; businessName: string } }
interface Detail extends Row { documentUrl: string | null; automatedCheck: { status?: string; message?: string; registeredName?: string; matchScore?: number } | null; rejectionReason: string | null }

/** Business verification queue: open the document, run the registry check, approve or reject with a reason. */
export default function Verifications() {
  const isAdmin = useIsAdmin();
  const [status, setStatus] = useState('PENDING');
  const list = useAdmin<Row[]>(`/admin/business-verifications?status=${status}`);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useAdmin<Detail>(open ? `/admin/business-verifications/${open}` : null);
  const act = useAction();
  const [rejecting, setRejecting] = useState(false);
  const done = async () => { setOpen(null); setRejecting(false); await list.reload(); };

  return (
    <div className="space-y-4">
      <PageHeader title="Business verification" description="The registry check is advice only; a person decides."
        action={<Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOpen(null); }} className="h-9 w-auto"><option value="PENDING">Waiting</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></Select>} />
      {act.note}
      <Card>
        {list.error ? <div className="p-5"><ErrorState message={list.error} onRetry={list.reload} /></div> : !list.data ? <PageLoading /> : list.data.length === 0 ? <EmptyState title="Nothing here" /> : (
          <ul className="divide-y divide-line text-sm">
            {list.data.map((v) => (
              <li key={v.id} className="px-5 py-3">
                <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen(open === v.id ? null : v.id)}>
                  <span><span className="font-medium">{v.registeredName}</span> <span className="text-ink-3">· {v.registrationType} {v.registrationNumber} · {v.tenant.businessName} · {day(v.createdAt)}</span></span>
                  <Badge tone={v.status === 'APPROVED' ? 'good' : v.status === 'REJECTED' ? 'bad' : 'warn'}>{v.status.toLowerCase()}</Badge>
                </button>
                {open === v.id && (
                  <div className="mt-3 space-y-3 rounded-lg border border-line p-3">
                    {!detail.data ? <PageLoading /> : <>
                      <p><Link href={`/admin/sellers/${v.tenant.id}`} className="text-brand-700">Open seller</Link>{detail.data.documentUrl && <> · <a href={detail.data.documentUrl} target="_blank" rel="noopener noreferrer" className="text-brand-700">View document</a></>}</p>
                      <p className="text-ink-2">Registry check: {detail.data.automatedCheck ? `${detail.data.automatedCheck.status ?? ''} ${detail.data.automatedCheck.registeredName ? `— ${detail.data.automatedCheck.registeredName}` : ''} ${detail.data.automatedCheck.matchScore != null ? `(${detail.data.automatedCheck.matchScore}% match)` : ''} ${detail.data.automatedCheck.message ?? ''}` : 'not run'}</p>
                      {detail.data.rejectionReason && <p className="text-bad">Rejected: {detail.data.rejectionReason}</p>}
                      {v.status === 'PENDING' && <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" loading={act.busy === 'check'} onClick={() => void act.run('check', async () => { await adminCall(`/admin/business-verifications/${v.id}/registry-check`, 'POST'); await detail.reload(); }, 'Registry check done.')}>Run registry check</Button>
                        {isAdmin && <Button size="sm" loading={act.busy === 'approve'} onClick={() => void act.run('approve', async () => { await adminCall(`/admin/business-verifications/${v.id}/approve`, 'POST'); await done(); }, 'Approved. The store now shows as verified.')}>Approve</Button>}
                        {isAdmin && !rejecting && <Button size="sm" variant="danger" onClick={() => setRejecting(true)}>Reject</Button>}
                      </div>}
                      {rejecting && <ReasonForm label="What should the seller fix?" action="Reject" busy={act.busy === 'reject'} onCancel={() => setRejecting(false)}
                        onSubmit={(reason) => void act.run('reject', async () => { await adminCall(`/admin/business-verifications/${v.id}/reject`, 'POST', { reason }); await done(); }, 'Rejected; the seller is told why.')} />}
                    </>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
