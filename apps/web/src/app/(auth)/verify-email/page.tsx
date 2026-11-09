'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Alert, ButtonLink, Card, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';

function Verify() {
  const token = useSearchParams().get('token') ?? '';
  const { status, reload } = useAuth();
  const [state, setState] = useState<'working' | 'done' | 'error'>(token ? 'working' : 'error');
  const [error, setError] = useState<string | null>(token ? null : 'This verification link is incomplete.');
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return; // tokens are single use: never post twice (StrictMode double effects)
    sent.current = true;
    api('/auth/verify-email', { method: 'POST', body: { token }, tenant: false })
      .then(() => setState('done'))
      .catch((e) => { setError(errorMessage(e)); setState('error'); });
  }, [token]);

  useEffect(() => {
    if (state === 'done' && status === 'authenticated') void reload();
  }, [state, status, reload]);

  return (
    <Card className="w-full max-w-md p-6 sm:p-8">
      <h1 className="text-xl font-semibold tracking-tight">Email verification</h1>
      <div className="mt-6">
        {state === 'working' && <PageLoading label="Verifying" />}
        {state === 'done' && <Alert tone="good" title="Your email is verified">Thanks — your account is confirmed.</Alert>}
        {state === 'error' && (
          <Alert tone="bad" title="We couldn't verify your email">
            {error} You can request a new link from your onboarding checklist.
          </Alert>
        )}
      </div>
      {state !== 'working' && (
        <ButtonLink href={status === 'authenticated' ? '/onboarding' : '/login?next=/onboarding'} className="mt-4 w-full">
          {status === 'authenticated' ? 'Continue setup' : 'Sign in'}
        </ButtonLink>
      )}
    </Card>
  );
}

export default function VerifyEmailPage() {
  return <Suspense fallback={<PageLoading />}><Verify /></Suspense>;
}
