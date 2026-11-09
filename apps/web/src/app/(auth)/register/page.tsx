'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Field, Input, PageLoading, Select, Textarea, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatBps, formatMoney } from '@/lib/money';
import type { Plan } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { E164, PASSWORD, PASSWORD_HINT, normalisePhone } from '@/lib/nav';

const NG_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti',
  'Enugu', 'FCT – Abuja', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger',
  'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];
const COUNTRIES: Array<[string, string]> = [['NG', 'Nigeria'], ['GH', 'Ghana'], ['KE', 'Kenya'], ['ZA', 'South Africa'], ['RW', 'Rwanda'], ['CI', "Côte d'Ivoire"], ['SN', 'Senegal'], ['EG', 'Egypt']];
const CATEGORIES = [
  'Fashion & Apparel', 'Beauty & Personal Care', 'Jewellery & Accessories', 'Electronics & Gadgets', 'Food & Groceries',
  'Home & Living', 'Health & Wellness', 'Kids & Baby', 'Art & Crafts', 'Other',
];
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

interface Form {
  businessName: string; ownerFullName: string; email: string; phone: string; country: string; state: string; city: string;
  businessAddress: string; businessCategory: string; storeUsername: string; businessType: 'INDIVIDUAL' | 'REGISTERED_BUSINESS';
  password: string; acceptTerms: boolean; acceptPrivacy: boolean;
}

const initial: Form = {
  businessName: '', ownerFullName: '', email: '', phone: '', country: 'NG', state: '', city: '', businessAddress: '',
  businessCategory: '', storeUsername: '', businessType: 'INDIVIDUAL', password: '', acceptTerms: false, acceptPrivacy: false,
};

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function validate(f: Form): Partial<Record<keyof Form, string>> {
  const e: Partial<Record<keyof Form, string>> = {};
  if (f.businessName.trim().length < 2) e.businessName = 'Enter your business name';
  if (f.ownerFullName.trim().length < 2) e.ownerFullName = 'Enter your full name';
  if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) e.email = 'Enter a valid email address';
  if (!E164.test(normalisePhone(f.phone, f.country))) e.phone = 'Enter a valid phone number, e.g. 0803 123 4567';
  if (f.state.trim().length < 2) e.state = 'Choose your state';
  if (f.city.trim().length < 2) e.city = 'Enter your city';
  if (f.businessAddress.trim().length < 5) e.businessAddress = 'Enter your business address';
  if (!f.businessCategory) e.businessCategory = 'Choose a category';
  if (!SLUG.test(f.storeUsername)) e.storeUsername = '3–40 lowercase letters, numbers or hyphens';
  if (!PASSWORD.test(f.password)) e.password = PASSWORD_HINT;
  if (!f.acceptTerms) e.acceptTerms = 'You must accept the terms of service';
  if (!f.acceptPrivacy) e.acceptPrivacy = 'You must accept the privacy policy';
  return e;
}

function RegisterForm() {
  const { startSession, status } = useAuth();
  const router = useRouter();
  const requestedPlan = useSearchParams().get('plan');
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [model, setModel] = useState<'SUBSCRIPTION' | 'COMMISSION'>('SUBSCRIPTION');
  useEffect(() => {
    api<Plan[]>('/plans', { tenant: false }).then((ps) => {
      setPlans(ps);
      if (ps.find((p) => p.code === requestedPlan)?.pricingModel === 'COMMISSION') setModel('COMMISSION');
    }).catch(() => setPlans([])); // without plans the seller starts on the default trial and can choose later
  }, [requestedPlan]);
  const commissionPlan = plans?.find((p) => p.pricingModel === 'COMMISSION');
  const entryPlan = plans?.find((p) => p.pricingModel === 'SUBSCRIPTION' && p.monthlyPriceMinor !== null);
  const requested = plans?.find((p) => p.code === requestedPlan && p.pricingModel === 'SUBSCRIPTION' && p.monthlyPriceMinor !== null);
  const plan = model === 'COMMISSION' ? commissionPlan?.code : requested?.code;
  const [f, setF] = useState<Form>(initial);
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errors = useMemo(() => validate(f), [f]);
  const show = (k: keyof Form) => (submitted ? errors[k] : undefined);

  useEffect(() => {
    if (status === 'authenticated' && !busy) router.replace('/dashboard');
  }, [status, busy, router]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((prev) => {
    const next = { ...prev, [k]: v };
    if (k === 'businessName' && !slugTouched) next.storeUsername = slugify(String(v));
    if (k === 'country') next.state = '';
    return next;
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const res = await api<{ accessToken: string; expiresIn: number }>('/auth/register', {
        method: 'POST', tenant: false,
        body: { ...f, email: f.email.trim(), phone: normalisePhone(f.phone, f.country), state: f.state.replace('FCT – Abuja', 'FCT') },
      });
      await startSession(res);
      if (plan && plan !== entryPlan?.code) {
        // Trial plan switch is immediate and free; if it fails the seller can change it in Billing.
        await api('/billing/subscription/change', { method: 'POST', body: { planCode: plan, interval: 'MONTHLY' } }).catch(() => undefined);
      }
      router.replace('/onboarding');
    } catch (err) {
      setServerError(errorMessage(err));
      setBusy(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  if (status === 'loading') return <PageLoading label="Checking your session" />;

  return (
    <Card className="w-full max-w-2xl p-6 sm:p-8">
      <h1 className="text-xl font-semibold tracking-tight">Create your store</h1>
      <p className="mt-1 text-sm text-ink-3">14-day free trial. No card required.</p>
      <form onSubmit={submit} className="mt-6 space-y-6" noValidate>
        {serverError && <Alert tone="bad">{serverError}</Alert>}

        <fieldset className="space-y-4">
          <legend className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Your business</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business name" error={show('businessName')}>
              {(p) => <Input {...p} autoComplete="organization" value={f.businessName} onChange={(e) => set('businessName', e.target.value)} />}
            </Field>
            <Field label="Business category" error={show('businessCategory')}>
              {(p) => (
                <Select {...p} value={f.businessCategory} onChange={(e) => set('businessCategory', e.target.value)}>
                  <option value="">Choose…</option>
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <div role="radiogroup" aria-label="Business type" className="grid gap-3 sm:grid-cols-2">
            {([['INDIVIDUAL', 'Individual seller', 'Selling in your own name'], ['REGISTERED_BUSINESS', 'Registered business', 'Registered with CAC']] as const).map(([v, t, d]) => (
              <label key={v} className={cx('flex cursor-pointer gap-3 rounded-[var(--radius-control)] border p-3', f.businessType === v ? 'border-brand-500 bg-brand-50' : 'border-line-strong')}>
                <input type="radio" name="businessType" className="mt-1 accent-[var(--color-brand-600)]" checked={f.businessType === v} onChange={() => set('businessType', v)} />
                <span><span className="block text-sm font-medium">{t}</span><span className="block text-[13px] text-ink-3">{d}</span></span>
              </label>
            ))}
          </div>
          {f.businessType === 'REGISTERED_BUSINESS' && (
            <p className="text-[13px] text-ink-3">After sign-up, add your RC/BN number and CAC certificate in Settings → Business verification.</p>
          )}
          <Field label="Store username" error={show('storeUsername')} hint={<>Your store link: <span className="font-medium text-ink-2">livesell.africa/store/{f.storeUsername || 'yourname'}</span></>}>
            {(p) => <Input {...p} autoCapitalize="none" spellCheck={false} value={f.storeUsername} onChange={(e) => { setSlugTouched(true); set('storeUsername', e.target.value.toLowerCase()); }} />}
          </Field>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Location</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Country">
              {(p) => <Select {...p} value={f.country} onChange={(e) => set('country', e.target.value)}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>}
            </Field>
            <Field label="State" error={show('state')}>
              {(p) => f.country === 'NG' ? (
                <Select {...p} value={f.state} onChange={(e) => set('state', e.target.value)}>
                  <option value="">Choose…</option>
                  {NG_STATES.map((s) => <option key={s}>{s}</option>)}
                </Select>
              ) : <Input {...p} value={f.state} onChange={(e) => set('state', e.target.value)} />}
            </Field>
            <Field label="City" error={show('city')}>
              {(p) => <Input {...p} autoComplete="address-level2" value={f.city} onChange={(e) => set('city', e.target.value)} />}
            </Field>
          </div>
          <Field label="Business address" error={show('businessAddress')}>
            {(p) => <Textarea {...p} rows={2} className="min-h-0" autoComplete="street-address" value={f.businessAddress} onChange={(e) => set('businessAddress', e.target.value)} />}
          </Field>
        </fieldset>

        {commissionPlan && entryPlan && (
          <fieldset className="space-y-3">
            <legend className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">How would you like to pay LiveSell?</legend>
            <div role="radiogroup" className="grid gap-3 sm:grid-cols-2">
              {([
                ['SUBSCRIPTION', 'Subscription', `From ${formatMoney(entryPlan.monthlyPriceMinor, entryPlan.currency)}/month. No commission on your sales.`],
                ['COMMISSION', commissionPlan.name, `No monthly fee. ${formatBps(commissionPlan.commissionBps ?? 0)} of each verified sale.`],
              ] as const).map(([v, t, d]) => (
                <label key={v} className={cx('flex cursor-pointer gap-3 rounded-[var(--radius-control)] border p-3', model === v ? 'border-brand-500 bg-brand-50' : 'border-line-strong')}>
                  <input type="radio" name="pricingModel" className="mt-1 accent-[var(--color-brand-600)]" checked={model === v} onChange={() => setModel(v)} />
                  <span><span className="block text-sm font-medium">{t}</span><span className="block text-[13px] text-ink-3">{d}</span></span>
                </label>
              ))}
            </div>
            <p className="text-[13px] text-ink-3">Both start with a free {entryPlan.trialDays}-day trial — no fees or commission during the trial. You can switch any time.</p>
          </fieldset>
        )}

        <fieldset className="space-y-4">
          <legend className="text-[13px] font-semibold uppercase tracking-wide text-ink-3">Your account</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Your full name" error={show('ownerFullName')}>
              {(p) => <Input {...p} autoComplete="name" value={f.ownerFullName} onChange={(e) => set('ownerFullName', e.target.value)} />}
            </Field>
            <Field label="Phone number" error={show('phone')} hint="We'll text you a code to verify it.">
              {(p) => <Input {...p} type="tel" autoComplete="tel" inputMode="tel" placeholder="0803 123 4567" value={f.phone} onChange={(e) => set('phone', e.target.value)} />}
            </Field>
            <Field label="Email" error={show('email')}>
              {(p) => <Input {...p} type="email" autoComplete="email" value={f.email} onChange={(e) => set('email', e.target.value)} />}
            </Field>
            <Field label="Password" error={show('password')} hint={PASSWORD_HINT}>
              {(p) => <Input {...p} type="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password', e.target.value)} />}
            </Field>
          </div>
          <div className="space-y-2">
            {([['acceptTerms', 'terms of service', '/terms'], ['acceptPrivacy', 'privacy policy', '/privacy']] as const).map(([k, label, href]) => (
              <div key={k}>
                <label className="flex items-start gap-2 text-sm text-ink-2">
                  <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-brand-600)]" checked={f[k]} onChange={(e) => set(k, e.target.checked)} />
                  <span>I accept the <Link href={href} target="_blank" className="font-medium text-brand-700 hover:underline">{label}</Link></span>
                </label>
                {show(k) && <p className="ml-6 text-[13px] text-bad">{show(k)}</p>}
              </div>
            ))}
          </div>
        </fieldset>

        <Button type="submit" size="lg" className="w-full" loading={busy}>Create my store</Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-3">
        Already have an account? <Link href="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link>
      </p>
    </Card>
  );
}

export default function RegisterPage() {
  return <Suspense fallback={<PageLoading />}><RegisterForm /></Suspense>;
}
