'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, PageLoading } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { safeNext } from '@/lib/nav';

function LoginForm() {
  const { login, status } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, next, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
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
        <Field label="Email">
          {(p) => <Input {...p} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Password">
          {(p) => <Input {...p} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-sm font-medium text-brand-700 hover:underline">Forgot password?</Link>
        </div>
        <Button type="submit" className="w-full" loading={busy} disabled={!email || !password}>Sign in</Button>
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
