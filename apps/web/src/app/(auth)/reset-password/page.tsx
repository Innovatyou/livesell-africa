'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, ButtonLink, Card, Field, Input, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { PASSWORD, PASSWORD_HINT } from '@/lib/nav';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invalid = password && !PASSWORD.test(password) ? PASSWORD_HINT : null;
  const mismatch = confirm && confirm !== password ? 'Passwords do not match' : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (invalid || mismatch || !password) return;
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, newPassword: password }, tenant: false });
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <Card className="w-full max-w-md p-6 sm:p-8">
        <Alert tone="bad" title="This reset link is incomplete">Open the link from your email again, or request a new one.</Alert>
        <ButtonLink href="/forgot-password" variant="secondary" className="mt-4 w-full">Request a new link</ButtonLink>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md p-6 sm:p-8">
      <h1 className="text-xl font-semibold tracking-tight">Choose a new password</h1>
      {done ? (
        <>
          <Alert tone="good" className="mt-6" title="Password updated">You&apos;ve been signed out of all devices. Sign in with your new password.</Alert>
          <ButtonLink href="/login" className="mt-4 w-full">Sign in</ButtonLink>
        </>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          {error && <Alert tone="bad">{error} {error.includes('expired') && <Link href="/forgot-password" className="font-medium underline">Request a new link</Link>}</Alert>}
          <Field label="New password" hint={PASSWORD_HINT} error={invalid}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <Field label="Confirm new password" error={mismatch}>{(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
          <Button type="submit" className="w-full" loading={busy} disabled={!password || !!invalid || !!mismatch || !confirm}>Update password</Button>
        </form>
      )}
    </Card>
  );
}

export default function ResetPasswordPage() {
  return <Suspense fallback={<PageLoading />}><ResetForm /></Suspense>;
}
