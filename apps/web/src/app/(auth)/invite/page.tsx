'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Button, ButtonLink, Card, Field, Input, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { rememberTenant, useAuth } from '@/lib/auth';
import { E164, PASSWORD, PASSWORD_HINT, normalisePhone } from '@/lib/nav';

interface InviteInfo { businessName: string; storeSlug: string; roleName: string; email: string; expiresAt: string; accountExists: boolean }

function Invite() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const { status, me, startSession, reload, logout } = useAuth();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(token ? null : 'This invitation link is incomplete.');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    api<InviteInfo>('/invitations/lookup', { method: 'POST', body: { token }, tenant: false })
      .then(setInfo)
      .catch((e) => setLoadError(errorMessage(e)));
  }, [token]);

  async function acceptExisting() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ tenant: { id: string } }>('/invitations/accept', { method: 'POST', body: { token }, tenant: false });
      rememberTenant(r.tenant.id); // open the workspace they just joined
      await reload();
      router.replace('/dashboard');
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function acceptNew(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string | boolean> = { token, fullName: fullName.trim(), password, acceptTerms: true };
      if (phone.trim()) body.phone = normalisePhone(phone);
      const r = await api<{ accessToken: string; expiresIn: number }>('/invitations/accept-new', { method: 'POST', body, tenant: false });
      await startSession(r);
      router.replace('/dashboard');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <Card className="w-full max-w-md p-6 sm:p-8">
        <Alert tone="bad" title="This invitation can't be used">{loadError} Ask the store owner to send you a new invitation.</Alert>
      </Card>
    );
  }
  if (!info || status === 'loading') return <PageLoading label="Opening your invitation" />;

  const signedInAsInvitee = status === 'authenticated' && me?.email.toLowerCase() === info.email.toLowerCase();
  const signedInAsOther = status === 'authenticated' && !signedInAsInvitee;
  const phoneInvalid = phone.trim() && !E164.test(normalisePhone(phone)) ? 'Enter a valid phone number' : null;
  const pwInvalid = password && !PASSWORD.test(password) ? PASSWORD_HINT : null;

  return (
    <Card className="w-full max-w-md p-6 sm:p-8">
      <p className="text-sm text-ink-3">You&apos;ve been invited to join</p>
      <h1 className="mt-1 text-xl font-semibold tracking-tight">{info.businessName}</h1>
      <p className="mt-1 text-sm text-ink-2">as <span className="font-medium">{info.roleName}</span> · {info.email}</p>
      <div className="mt-6 space-y-4">
        {error && <Alert tone="bad">{error}</Alert>}
        {signedInAsInvitee && <Button className="w-full" loading={busy} onClick={acceptExisting}>Accept invitation</Button>}
        {signedInAsOther && (
          <>
            <Alert tone="warn">You&apos;re signed in as {me?.email}. This invitation is for {info.email}.</Alert>
            <Button variant="secondary" className="w-full" onClick={() => void logout()}>Sign out and switch account</Button>
          </>
        )}
        {status === 'anonymous' && info.accountExists && (
          <>
            <p className="text-sm text-ink-2">You already have a LiveSell account. Sign in as {info.email} to accept.</p>
            <ButtonLink href={`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`} className="w-full">Sign in to accept</ButtonLink>
          </>
        )}
        {status === 'anonymous' && !info.accountExists && (
          <form onSubmit={acceptNew} className="space-y-4">
            <Field label="Your full name">{(p) => <Input {...p} autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />}</Field>
            <Field label="Phone number (optional)" error={phoneInvalid}>{(p) => <Input {...p} type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
            <Field label="Create a password" hint={PASSWORD_HINT} error={pwInvalid}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
            <label className="flex items-start gap-2 text-sm text-ink-2">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-brand-600)]" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
              <span>I accept the <Link href="/terms" target="_blank" className="font-medium text-brand-700 hover:underline">terms of service</Link> and <Link href="/privacy" target="_blank" className="font-medium text-brand-700 hover:underline">privacy policy</Link></span>
            </label>
            <Button type="submit" className="w-full" loading={busy} disabled={!accepted || fullName.trim().length < 2 || !PASSWORD.test(password) || !!phoneInvalid}>Join {info.businessName}</Button>
          </form>
        )}
      </div>
    </Card>
  );
}

export default function InvitePage() {
  return <Suspense fallback={<PageLoading />}><Invite /></Suspense>;
}
