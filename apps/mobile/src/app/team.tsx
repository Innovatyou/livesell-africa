import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Badge, Button, Card, Choice, ErrorBox, Field, Loading, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

interface Member { id: string; status: 'ACTIVE' | 'DISABLED'; role: { key: string; name: string }; user: { id: string; fullName: string; email: string } }
interface Invitation { id: string; email: string; roleKey: string; status: 'PENDING' | 'EXPIRED'; expiresAt: string }

/** Roles a store can give its staff (the API enforces exactly these permissions). */
const ROLES: Array<[string, string, string]> = [
  ['STORE_MANAGER', 'Store manager', 'Products, stock, orders, customers, live sessions, deliveries and reports. Can confirm bank transfers. No staff, payouts or plan.'],
  ['SALES_ASSISTANT', 'Sales assistant', 'Records orders, moves them along and checks stock. No money or settings.'],
  ['LIVE_MODERATOR', 'Live moderator', 'Creates and runs live sessions and records orders during the live.'],
  ['DISPATCHER', 'Dispatch & delivery', 'Packs and sends orders, updates deliveries and couriers. Sees no payments.'],
  ['ACCOUNTANT', 'Accounts', 'Sees payments, confirms bank transfers and reads reports. Can’t change stock, staff or settings.'],
  ['CUSTOMER_CARE', 'Customer care', 'Answers customers, creates orders and keeps customer notes.'],
];
const roleName = (k: string) => (k === 'OWNER' ? 'Business owner' : ROLES.find(([r]) => r === k)?.[1] ?? k);
const day = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short' }).format(new Date(s));

/** Team: invite staff by email with a role, change roles, switch access off, and manage open invitations. */
export default function Team() {
  useTheme();
  const { can, me } = useAuth();
  const allowed = can('staff:manage');
  const members = useApi<Member[]>(allowed ? '/workspace/members' : null);
  const invites = useApi<Invitation[]>(allowed ? '/staff/invitations' : null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('SALES_ASSISTANT');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  if (!allowed) return <Screen><Notice tone="warn">Only the business owner manages the team.</Notice></Screen>;
  if (members.error) return <Screen><ErrorBox message={members.error} onRetry={members.reload} /></Screen>;
  if (!members.data || !invites.data) return <Loading />;

  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'good', text: ok });
      setEditing(null);
      await Promise.all([members.reload(), invites.reload()]);
    } catch (e) {
      const limit = e instanceof ApiError && e.code === 'PLAN_LIMIT_REACHED';
      setMsg({ tone: 'bad', text: limit ? `${(e as Error).message} Upgrade your plan in More → Plan & billing to add more people.` : (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const to = email.trim().toLowerCase();
  const roleDesc = ROLES.find(([k]) => k === role)?.[2];

  return (
    <Screen refreshing={members.loading} onRefresh={() => { void members.reload(); void invites.reload(); }}>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}

      <Card style={{ gap: 10 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Invite a team member</Text>
        <Field label="Their email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="tunde@example.com" />
        <Choice label="Role" value={role} onChange={setRole} options={ROLES.map(([k, n]) => [k, n] as [string, string])} />
        <Muted>{roleDesc}</Muted>
        <Button title="Send invitation" disabled={!/^\S+@\S+\.\S+$/.test(to)} loading={busy === 'invite'}
          onPress={() => void act('invite', async () => { await api('/staff/invitations', { method: 'POST', body: { email: to, roleKey: role } }); setEmail(''); }, `Invitation sent to ${to}. They open the email link, set a password, then sign in to this app.`)} />
      </Card>

      <Text style={{ fontWeight: '700', color: c.ink }}>Members ({members.data.length})</Text>
      {members.data.map((m) => {
        const locked = m.role.key === 'OWNER' || m.user.id === me?.id;
        return (
          <Card key={m.id} style={{ gap: 8 }}>
            <Row>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.ink, fontWeight: '600' }}>{m.user.fullName}{m.user.id === me?.id ? ' (you)' : ''}</Text>
                <Muted>{m.user.email}</Muted>
              </View>
              {m.status === 'DISABLED' ? <Badge tone="bad">No access</Badge> : <Badge tone={m.role.key === 'OWNER' ? 'good' : 'neutral'}>{roleName(m.role.key)}</Badge>}
            </Row>
            {!locked ? (
              editing === m.id ? (
                <>
                  <Choice label={`Role for ${m.user.fullName}`} value={m.role.key} onChange={(k) => void act(`role-${m.id}`, () => api(`/staff/members/${m.id}`, { method: 'PATCH', body: { roleKey: k } }), `${m.user.fullName} is now ${roleName(k)}.`)}
                    options={ROLES.map(([k, n]) => [k, n] as [string, string])} />
                  <Button variant="secondary" title="Done" onPress={() => setEditing(null)} />
                </>
              ) : (
                <Row style={{ justifyContent: 'flex-start' }}>
                  <Button variant="secondary" title="Change role" disabled={busy !== null} onPress={() => setEditing(m.id)} />
                  <Button variant={m.status === 'DISABLED' ? 'secondary' : 'danger'} title={m.status === 'DISABLED' ? 'Give access back' : 'Remove access'} loading={busy === `st-${m.id}`} disabled={busy !== null}
                    onPress={() => {
                      const off = m.status !== 'DISABLED';
                      const go = () => void act(`st-${m.id}`, () => api(`/staff/members/${m.id}`, { method: 'PATCH', body: { status: off ? 'DISABLED' : 'ACTIVE' } }), off ? `${m.user.fullName} can no longer open your store.` : `${m.user.fullName} has access again.`);
                      if (off) Alert.alert('Remove access?', `${m.user.fullName} will be signed out of your store straight away.`, [{ text: 'Keep', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: go }]);
                      else go();
                    }} />
                </Row>
              )
            ) : null}
          </Card>
        );
      })}

      <Text style={{ fontWeight: '700', color: c.ink }}>Invitations</Text>
      {invites.data.length === 0 ? <Muted>No open invitations.</Muted> : invites.data.map((i) => (
        <Card key={i.id} style={{ gap: 8 }}>
          <Text style={{ color: c.ink, fontWeight: '600' }}>{i.email}</Text>
          <Muted>{roleName(i.roleKey)} · {i.status === 'EXPIRED' ? `expired ${day(i.expiresAt)}` : `expires ${day(i.expiresAt)}`}</Muted>
          <Row style={{ justifyContent: 'flex-start' }}>
            <Button variant="secondary" title="Resend" loading={busy === `re-${i.id}`} disabled={busy !== null} onPress={() => void act(`re-${i.id}`, () => api(`/staff/invitations/${i.id}/resend`, { method: 'POST', body: {} }), `New link sent to ${i.email}.`)} />
            {i.status === 'PENDING' ? <Button variant="secondary" title="Cancel invite" loading={busy === `rv-${i.id}`} disabled={busy !== null} onPress={() => void act(`rv-${i.id}`, () => api(`/staff/invitations/${i.id}`, { method: 'DELETE' }), `Invitation for ${i.email} cancelled.`)} /> : null}
          </Row>
        </Card>
      ))}
      <Muted>Each role only sees what it needs; the server checks every action. Your plan sets how many people you can add.</Muted>
    </Screen>
  );
}
