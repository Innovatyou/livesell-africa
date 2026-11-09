'use client';

import { useEffect, useState } from 'react';
import { ApiError, api, errorMessage } from '@/lib/api';
import { E164, normalisePhone } from '@/lib/nav';
import { Alert, Button, Field, Input } from './ui';

interface SendResult { status: 'sent' | 'already_verified'; phone: string; resendAfterSeconds?: number }

/** Send a 6-digit SMS code and verify it. Shows honest states for cooldowns and SMS being unavailable. */
export function PhoneVerify({ currentPhone, onVerified }: { currentPhone: string | null; onVerified: () => void }) {
  const [phone, setPhone] = useState(currentPhone ?? '');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const normalised = normalisePhone(phone);
  const phoneInvalid = phone && !E164.test(normalised) ? 'Enter a valid phone number, e.g. 0803 123 4567' : null;

  async function send() {
    setBusy('send');
    setError(null);
    try {
      const body = normalised && normalised !== currentPhone ? { phone: normalised } : {};
      const r = await api<SendResult>('/auth/phone/send-otp', { method: 'POST', body, tenant: false });
      if (r.status === 'already_verified') return onVerified();
      setSentTo(r.phone);
      setCooldown(r.resendAfterSeconds ?? 60);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setUnavailable(true);
      else setError(errorMessage(e));
      const m = e instanceof ApiError ? /(\d+) seconds/.exec(e.message) : null;
      if (m) setCooldown(Number(m[1]));
    } finally {
      setBusy(null);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy('verify');
    setError(null);
    try {
      await api('/auth/phone/verify', { method: 'POST', body: { code }, tenant: false });
      onVerified();
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(null);
    }
  }

  if (unavailable) {
    return <Alert tone="info" title="SMS verification opens soon">We&apos;re finishing our SMS integration. You can keep setting up your store in the meantime.</Alert>;
  }

  return (
    <div className="space-y-3">
      {!sentTo ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Phone number" error={phoneInvalid} className="flex-1">
            {(p) => <Input {...p} type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
          </Field>
          <Button onClick={() => void send()} loading={busy === 'send'} disabled={!phone || !!phoneInvalid || cooldown > 0}>
            {cooldown > 0 ? `Send code in ${cooldown}s` : 'Send code'}
          </Button>
        </div>
      ) : (
        <form onSubmit={verify} className="space-y-3">
          <p className="text-sm text-ink-2">Enter the 6-digit code we sent to <span className="font-medium">{sentTo}</span>.</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Verification code" className="flex-1">
              {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="tracking-[0.4em] tabular" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}
            </Field>
            <Button type="submit" loading={busy === 'verify'} disabled={code.length !== 6}>Verify</Button>
          </div>
          <div className="flex gap-3 text-sm">
            <button type="button" className="font-medium text-brand-700 disabled:text-ink-4" disabled={cooldown > 0 || busy !== null} onClick={() => void send()}>
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
            </button>
            <button type="button" className="text-ink-3 hover:text-ink" onClick={() => { setSentTo(null); setCode(''); setError(null); }}>Change number</button>
          </div>
        </form>
      )}
      {error && <Alert tone="bad">{error}</Alert>}
    </div>
  );
}
