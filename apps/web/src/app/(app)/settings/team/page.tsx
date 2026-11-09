'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, EmptyState, ErrorState, Field, Input, Select, Skeleton } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Invitation, Member } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const ROLES: Array<[string, string, string]> = [
  ['STORE_MANAGER', 'Store manager', 'Products, orders, stock, customers and reports'],
  ['SALES_ASSISTANT', 'Sales assistant', 'Create orders and check availability'],
  ['LIVE_MODERATOR', 'Live moderator', 'Run live sessions and register orders'],
];
const roleName = (k: string) => (k === 'OWNER' ? 'Business owner' : ROLES.find(([r]) => r === k)?.[1] ?? k);
const date = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(s));

export default function TeamPage() {
  const { can, me } = useAuth();
  const allowed = can('staff:manage');
  const members = useApi<Member[]>(allowed ? '/workspace/members' : null);
  const invites = useApi<Invitation[]>(allowed ? '/staff/invitations' : null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('SALES_ASSISTANT');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string; upgrade?: boolean } | null>(null);

  if (!allowed) return <Card><EmptyState title="Only the owner manages the team" /></Card>;

  async function act(key: string, fn: () => Promise<unknown>, success: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'good', text: success });
      await Promise.all([members.reload(), invites.reload()]);
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e), upgrade: e instanceof ApiError && e.code === 'PLAN_LIMIT_REACHED' });
    } finally {
      setBusy(null);
    }
  }

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    const to = email.trim().toLowerCase();
    void act('invite', async () => {
      await api('/staff/invitations', { method: 'POST', body: { email: to, roleKey: role } });
      setEmail('');
    }, `Invitation sent to ${to}. The link is valid for 7 days.`);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Team" description="Invite people to help run your store. Each role only sees what it needs." />

      {msg && (
        <Alert tone={msg.tone} action={msg.upgrade && can('billing:manage') ? <ButtonLink href="/settings/billing" size="sm" variant="secondary">Upgrade plan</ButtonLink> : undefined}>
          {msg.text}
        </Alert>
      )}

      <Card>
        <CardHeader title="Invite a team member" />
        <form onSubmit={invite} className="grid gap-4 p-5 sm:grid-cols-[1fr_220px_auto] sm:items-end">
          <Field label="Email address">{(p) => <Input {...p} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />}</Field>
          <Field label="Role">{(p) => <Select {...p} value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</Select>}</Field>
          <Button type="submit" loading={busy === 'invite'} disabled={!/^\S+@\S+\.\S+$/.test(email.trim())}>Send invite</Button>
          <p className="text-[13px] text-ink-3 sm:col-span-3">{ROLES.find(([k]) => k === role)?.[2]}.</p>
        </form>
      </Card>

      <Card>
        <CardHeader title="Members" />
        {members.error ? <div className="p-5"><ErrorState message={members.error} onRetry={members.reload} /></div>
          : !members.data ? <div className="space-y-3 p-5">{[0, 1].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          : (
            <ul className="divide-y divide-line">
              {members.data.map((m) => {
                const locked = m.role.key === 'OWNER' || m.user.id === me?.id;
                return (
                  <li key={m.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {m.user.fullName}
                        {m.user.id === me?.id && <Badge>You</Badge>}
                        {m.status === 'DISABLED' && <Badge tone="bad">Disabled</Badge>}
                      </p>
                      <p className="truncate text-[13px] text-ink-3">{m.user.email}</p>
                    </div>
                    {locked ? (
                      <p className="text-sm text-ink-2">{roleName(m.role.key)}</p>
                    ) : (
                      <div className="flex items-center gap-2">
                        <label className="sr-only" htmlFor={`role-${m.id}`}>Role for {m.user.fullName}</label>
                        <Select id={`role-${m.id}`} className="h-9 w-44" value={m.role.key} disabled={busy !== null}
                          onChange={(e) => void act(`role-${m.id}`, () => api(`/staff/members/${m.id}`, { method: 'PATCH', body: { roleKey: e.target.value } }), `${m.user.fullName} is now a ${roleName(e.target.value).toLowerCase()}.`)}>
                          {ROLES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
                        </Select>
                        <Button size="sm" variant={m.status === 'DISABLED' ? 'secondary' : 'danger'} loading={busy === `status-${m.id}`} disabled={busy !== null}
                          onClick={() => void act(`status-${m.id}`, () => api(`/staff/members/${m.id}`, { method: 'PATCH', body: { status: m.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED' } }),
                            m.status === 'DISABLED' ? `${m.user.fullName} can sign in to your store again.` : `${m.user.fullName} no longer has access.`)}>
                          {m.status === 'DISABLED' ? 'Enable' : 'Disable'}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      </Card>

      <Card>
        <CardHeader title="Invitations" description="Pending and expired" />
        {invites.error ? <div className="p-5"><ErrorState message={invites.error} onRetry={invites.reload} /></div>
          : !invites.data ? <div className="p-5"><Skeleton className="h-10 w-full" /></div>
          : invites.data.length === 0 ? <EmptyState title="No open invitations">People you invite appear here until they accept.</EmptyState>
          : (
            <ul className="divide-y divide-line">
              {invites.data.map((i) => (
                <li key={i.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{i.email}</p>
                    <p className="text-[13px] text-ink-3">
                      {roleName(i.roleKey)} · {i.status === 'EXPIRED' ? <span className="text-warn">Expired {date(i.expiresAt)}</span> : `Expires ${date(i.expiresAt)}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" loading={busy === `resend-${i.id}`} disabled={busy !== null}
                      onClick={() => void act(`resend-${i.id}`, () => api(`/staff/invitations/${i.id}/resend`, { method: 'POST', body: {} }), `New invitation link sent to ${i.email}.`)}>
                      Resend
                    </Button>
                    {i.status === 'PENDING' && (
                      <Button size="sm" variant="ghost" loading={busy === `revoke-${i.id}`} disabled={busy !== null}
                        onClick={() => void act(`revoke-${i.id}`, () => api(`/staff/invitations/${i.id}`, { method: 'DELETE' }), `Invitation for ${i.email} revoked.`)}>
                        Revoke
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </div>
  );
}
