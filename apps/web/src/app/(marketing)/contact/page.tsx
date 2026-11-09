'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Card, Field, Input, PageLoading, Select, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { E164, normalisePhone } from '@/lib/nav';

const BANDS = ['Under 200', '200–1,000', '1,000–5,000', '5,000–20,000', 'Over 20,000'];
const INTERESTS: Array<[string, string]> = [['ENTERPRISE', 'Enterprise / custom pricing'], ['BUSINESS', 'Business plan'], ['PAY_AS_YOU_SELL', 'Pay as you sell (commission)'], ['', 'Something else']];

function ContactForm() {
  const params = useSearchParams();
  const initialPlan = params.get('plan') ?? 'ENTERPRISE';
  const [f, setF] = useState({
    fullName: '', email: '', phone: '', businessName: '', monthlyOrders: '', message: '', website: '',
    planInterest: INTERESTS.some(([k]) => k === initialPlan) ? initialPlan : 'ENTERPRISE',
  });
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null | undefined>(undefined);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  const errors: Partial<Record<keyof typeof f, string>> = {};
  if (f.fullName.trim().length < 2) errors.fullName = 'Enter your name';
  if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) errors.email = 'Enter a valid email address';
  if (f.phone.trim() && !E164.test(normalisePhone(f.phone))) errors.phone = 'Enter a valid phone number';
  if (f.businessName.trim().length < 2) errors.businessName = 'Enter your business name';
  if (f.message.trim().length < 10) errors.message = 'Tell us a little more (at least 10 characters)';
  const show = (k: keyof typeof f) => (submitted ? errors[k] : undefined);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setError(null);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const body: Record<string, string> = {
        fullName: f.fullName.trim(), email: f.email.trim(), businessName: f.businessName.trim(), message: f.message.trim(),
      };
      if (f.phone.trim()) body.phone = normalisePhone(f.phone);
      if (f.planInterest) body.planInterest = f.planInterest;
      if (f.monthlyOrders) body.monthlyOrders = f.monthlyOrders;
      if (f.website) body.website = f.website;
      const r = await api<{ status: 'received'; reference: string | null }>('/sales-inquiries', { method: 'POST', body, tenant: false });
      setReference(r.reference);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (reference !== undefined) {
    return (
      <Card className="p-6 sm:p-8">
        <Alert tone="good" title="Thanks — we've got your message">
          Our team will reply to {f.email.trim()} within one business day{reference ? ` (reference ${reference})` : ''}.
        </Alert>
        <p className="mt-4 text-sm text-ink-3">Want to look around first? <Link href="/register" className="font-medium text-brand-700 hover:underline">Start a free trial</Link>.</p>
      </Card>
    );
  }

  return (
    <Card className="p-6 sm:p-8">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name" error={show('fullName')}>{(p) => <Input {...p} autoComplete="name" value={f.fullName} onChange={(e) => set('fullName', e.target.value)} />}</Field>
          <Field label="Business name" error={show('businessName')}>{(p) => <Input {...p} autoComplete="organization" value={f.businessName} onChange={(e) => set('businessName', e.target.value)} />}</Field>
          <Field label="Work email" error={show('email')}>{(p) => <Input {...p} type="email" autoComplete="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}</Field>
          <Field label="Phone (optional)" error={show('phone')}>{(p) => <Input {...p} type="tel" autoComplete="tel" placeholder="0803 123 4567" value={f.phone} onChange={(e) => set('phone', e.target.value)} />}</Field>
          <Field label="I'm interested in">{(p) => <Select {...p} value={f.planInterest} onChange={(e) => set('planInterest', e.target.value)}>{INTERESTS.map(([k, l]) => <option key={l} value={k}>{l}</option>)}</Select>}</Field>
          <Field label="Orders per month (optional)">
            {(p) => <Select {...p} value={f.monthlyOrders} onChange={(e) => set('monthlyOrders', e.target.value)}><option value="">Choose…</option>{BANDS.map((b) => <option key={b}>{b}</option>)}</Select>}
          </Field>
        </div>
        <Field label="How can we help?" error={show('message')} hint={`${f.message.length}/3000`}>
          {(p) => <Textarea {...p} maxLength={3000} rows={5} value={f.message} onChange={(e) => set('message', e.target.value)} placeholder="Tell us about your business, channels and what you need." />}
        </Field>
        {/* Honeypot: hidden from people and assistive tech; bots fill it in. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label htmlFor="website">Website</label>
          <input id="website" name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set('website', e.target.value)} />
        </div>
        <p className="text-[13px] text-ink-3">We use these details only to reply to you. See our <Link href="/privacy" className="font-medium text-brand-700 hover:underline">privacy policy</Link>.</p>
        <Button type="submit" size="lg" className="w-full sm:w-auto" loading={busy}>Send message</Button>
      </form>
    </Card>
  );
}

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Talk to our sales team</h1>
      <p className="mt-2 text-ink-2">Custom pricing for larger brands, multiple stores, or a commission arrangement that fits how you sell.</p>
      <div className="relative mt-8"><Suspense fallback={<PageLoading />}><ContactForm /></Suspense></div>
    </div>
  );
}
