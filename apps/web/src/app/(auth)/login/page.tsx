'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, PageLoading, PasswordInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { safeNext } from '@/lib/nav';

const REMEMBER = 'ls.login.identifier';

function LoginForm() {
  const { login, status } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [identifier, setIdentifier] = useState('');
  const [remember, setRemember] = useState(true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, next, router]);

  // "Remember me" keeps only the email/phone in this browser, never the password.
  useEffect(() => {
    try { const v = localStorage.getItem(REMEMBER); if (v) setIdentifier(v); } catch { /* storage blocked */ }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const id = identifier.trim();
      await login(id.includes('@') ? id.toLowerCase() : id, password);
      try { if (remember) localStorage.setItem(REMEMBER, id); else localStorage.removeItem(REMEMBER); } catch { /* storage blocked */ }
      router.replace(next);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (status === 'loading') return <PageLoading label="Checking your session" />;

  return (
    <Card className="w-full max-w-md p-6 sm:p-8">
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-ink-3">Welcome back. Sign in to manage your store.</p>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        {error && <Alert tone="bad">{error}</Alert>}
        <Field label="Email or phone number" hint="For example ada@shop.ng or 0803 123 4567">
          {(p) => <Input {...p} type="text" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={identifier} onChange={(e) => setIdentifier(e.target.value)} />}
        </Field>
        <Field label="Password">
          {(p) => <PasswordInput {...p} autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" className="size-4 accent-[var(--color-brand-600)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember my email or phone
          </label>
          <Link href="/forgot-password" className="text-sm font-medium text-brand-700 hover:underline">Forgot password?</Link>
        </div>
        <Button type="submit" className="w-full" loading={busy} disabled={identifier.trim().length < 3 || !password}>Sign in</Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-3">
        New to LiveSell? <Link href="/register" className="font-medium text-brand-700 hover:underline">Create your store</Link>
      </p>
    </Card>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<PageLoading />}><LoginForm /></Suspense>;
}
