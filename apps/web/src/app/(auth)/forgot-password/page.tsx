'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email: email.trim() }, tenant: false });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-md p-6 sm:p-8">
      <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
      {sent ? (
        <Alert tone="good" className="mt-6" title="Check your email">
          If an account exists for {email}, we&apos;ve sent a link to reset your password. It expires in 30 minutes.
        </Alert>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <p className="text-sm text-ink-3">Enter the email you use for LiveSell and we&apos;ll send you a reset link.</p>
          {error && <Alert tone="bad">{error}</Alert>}
          <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Button type="submit" className="w-full" loading={busy} disabled={!email}>Send reset link</Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm"><Link href="/login" className="font-medium text-brand-700 hover:underline">Back to sign in</Link></p>
    </Card>
  );
}
