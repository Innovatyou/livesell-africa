'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import type { PaymentStatusResult } from '@/lib/types';
import { Logo } from './ui';

const OPEN = new Set(['INITIALIZED', 'PENDING', 'ABANDONED']);
const MAX_AUTO_CHECKS = 5;

/**
 * Where the payment provider (Paystack, Flutterwave, Bachs) sends the customer back. Coming back proves nothing: this
 * page asks our API, which verifies the payment with the provider server-side, and shows what the server concluded.
 */
function Result() {
  const params = useSearchParams();
  // Paystack appends reference/trxref, Flutterwave tx_ref, Bachs our reference (set on its success URL).
  const reference = params.get('reference') ?? params.get('trxref') ?? params.get('tx_ref') ?? '';
  const [result, setResult] = useState<PaymentStatusResult | null>(null);
  const [state, setState] = useState<'checking' | 'done' | 'missing' | 'error'>('checking');
  const checks = useRef(0);

  const check = useCallback(async () => {
    if (!/^[A-Za-z0-9.=-]{8,100}$/.test(reference)) { setState('missing'); return; }
    setState('checking');
    try {
      const r = await fetch(`${API_URL}/api/v1/payments/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference }), cache: 'no-store' });
      if (r.status === 404) { setState('missing'); return; }
      if (!r.ok) { setState('error'); return; }
      setResult(await r.json());
      setState('done');
    } catch {
      setState('error');
    }
  }, [reference]);

  useEffect(() => { void check(); }, [check]);
  // Providers can take a few seconds to confirm bank transfers and USSD; keep asking briefly.
  useEffect(() => {
    if (state !== 'done' || !result || !OPEN.has(result.status) || checks.current >= MAX_AUTO_CHECKS) return;
    const t = setTimeout(() => { checks.current++; void check(); }, 4000);
    return () => clearTimeout(t);
  }, [state, result, check]);

  const back = result?.kind === 'subscription' ? { href: '/settings/billing', label: 'Back to billing' }
    : result?.store && result.orderReference ? { href: `/store/${result.store.slug}/order/${result.orderReference}`, label: 'View your order' } : null;

  let title = 'Checking your payment…';
  let body: React.ReactNode = 'This takes a few seconds. Please keep this page open.';
  let tone = 'text-ink';
  if (state === 'missing') { title = 'We couldn’t find this payment'; body = 'Open the payment link again, or contact the seller with your order reference.'; }
  else if (state === 'error') { title = 'We couldn’t check your payment'; body = 'Your connection may have dropped. Nothing is lost — try again.'; }
  else if (state === 'done' && result) {
    const amount = formatMoney(result.amountMinor, result.currency);
    if (result.status === 'SUCCEEDED') { title = 'Payment confirmed'; tone = 'text-good'; body = `${amount} received${result.store ? ` by ${result.store.businessName}` : ''}. ${result.kind === 'order' ? `Order ${result.orderReference} is now paid.` : 'Your plan has been updated.'}`; }
    else if (result.status === 'FAILED' || result.status === 'REVERSED') { title = 'Payment not completed'; tone = 'text-bad'; body = `The payment of ${amount} didn’t go through and you were not charged for it. You can try again.`; }
    else if (result.providerDown) { title = 'Payment confirmation delayed'; body = 'The payment provider isn’t responding right now. If you paid, it will be confirmed automatically within a few minutes — don’t pay twice.'; }
    else { title = checks.current >= MAX_AUTO_CHECKS ? 'Payment not confirmed yet' : 'Checking your payment…'; body = checks.current >= MAX_AUTO_CHECKS ? 'If you completed the payment it will be confirmed automatically within a few minutes. If you closed the payment page, you can pay again from your order.' : `Waiting for the payment provider to confirm ${amount}.`; }
  }

  return (
    <div className="mx-auto max-w-md space-y-6 px-4 py-16 text-center">
      <Logo className="mx-auto" />
      <div role="status" aria-live="polite" className="rounded-[var(--radius-card)] border border-line bg-surface p-6">
        <h1 className={`text-lg font-semibold ${tone}`}>{title}</h1>
        <p className="mt-2 text-sm text-ink-2">{body}</p>
        {reference && <p className="mt-3 font-mono text-[12px] text-ink-4">Ref {reference}</p>}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {(state === 'error' || (state === 'done' && result && OPEN.has(result.status))) && (
            <button type="button" onClick={() => { checks.current = 0; void check(); }} className="h-10 rounded-[var(--radius-control)] border border-line px-4 text-sm font-medium">Check again</button>
          )}
          {back && <Link href={back.href} className="inline-flex h-10 items-center rounded-[var(--radius-control)] bg-brand-600 px-4 text-sm font-semibold text-white">{back.label}</Link>}
        </div>
      </div>
    </div>
  );
}

export function PaymentReturn() {
  return <Suspense fallback={<p className="py-16 text-center text-sm text-ink-3">Checking your payment…</p>}><Result /></Suspense>;
}
