'use client';

import { useEffect, useState } from 'react';
import { LogoUploader } from '@/components/logo-uploader';
import { PageHeader } from '@/components/page-header';
import { Alert, Button, Card, CardHeader, ErrorState, Field, Input, PageLoading, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { E164, normalisePhone } from '@/lib/nav';
import type { StoreProfile } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const SOCIALS: Array<[string, string, string]> = [
  ['instagram', 'Instagram', '@yourstore'], ['tiktok', 'TikTok', '@yourstore'], ['facebook', 'Facebook', 'yourstore'],
  ['x', 'X (Twitter)', '@yourstore'], ['youtube', 'YouTube', '@yourstore'],
];

interface Form {
  businessName: string; businessCategory: string; state: string; city: string; businessAddress: string; description: string;
  contactEmail: string; contactPhone: string; whatsappNumber: string; socialLinks: Record<string, string>;
}

const fromProfile = (p: StoreProfile): Form => ({
  businessName: p.businessName, businessCategory: p.businessCategory ?? '', state: p.state ?? '', city: p.city ?? '',
  businessAddress: p.address ?? '', description: p.storefront.description ?? '', contactEmail: p.storefront.contactEmail ?? '',
  contactPhone: p.storefront.contactPhone ?? '', whatsappNumber: p.storefront.whatsappNumber ?? '', socialLinks: { ...p.storefront.socialLinks },
});

export default function StoreSettingsPage() {
  const { can, reload: reloadSession } = useAuth();
  const canEdit = can('store:manage');
  const profile = useApi<StoreProfile>('/store/profile');
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (profile.data) setF(fromProfile(profile.data));
  }, [profile.data]);

  if (profile.error) return <ErrorState message={profile.error} onRetry={profile.reload} />;
  if (!profile.data || !f) return <PageLoading />;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF({ ...f, [k]: v });
  const phoneErr = (v: string) => (v && !E164.test(normalisePhone(v)) ? 'Enter a valid phone number' : null);
  const websiteErr = f.socialLinks.website && !/^https:\/\/\S+\.\S+/.test(f.socialLinks.website) ? 'Must start with https://' : null;
  const handleErr = (v?: string) => (v && !/^@?[A-Za-z0-9._]{1,60}$/.test(v) ? 'Handle only, e.g. @yourstore' : null);
  const invalid = !!(phoneErr(f.whatsappNumber) || phoneErr(f.contactPhone) || websiteErr || SOCIALS.some(([k]) => handleErr(f.socialLinks[k])) || f.businessName.trim().length < 2);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!f || invalid) return;
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        businessName: f.businessName.trim(), description: f.description.trim(), socialLinks: f.socialLinks,
      };
      for (const k of ['businessCategory', 'state', 'city', 'businessAddress', 'contactEmail'] as const) if (f[k].trim()) body[k] = f[k].trim();
      for (const k of ['contactPhone', 'whatsappNumber'] as const) if (f[k].trim()) body[k] = normalisePhone(f[k]);
      const updated = await api<StoreProfile>('/store/profile', { method: 'PATCH', body });
      profile.setData(updated);
      setMsg({ tone: 'good', text: 'Store profile saved.' });
      void reloadSession();
    } catch (err) {
      setMsg({ tone: 'bad', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Store profile" description={`Shown to customers at livesell.africa/store/${profile.data.slug}`} />
      {!canEdit && <Alert tone="info" className="mb-4">You can view the store profile. Only the owner can edit it.</Alert>}

      <Card className="mb-6">
        <CardHeader title="Logo" />
        <div className="p-5">
          <LogoUploader
            logoUrl={profile.data.storefront.logoUrl} businessName={profile.data.businessName} canEdit={canEdit}
            onChange={(url) => profile.setData({ ...profile.data!, storefront: { ...profile.data!.storefront, logoUrl: url } })}
          />
        </div>
      </Card>

      <PreordersCard
        on={!!profile.data.storefront.allowPreorders} canEdit={canEdit}
        onChange={(v) => profile.setData({ ...profile.data!, storefront: { ...profile.data!.storefront, allowPreorders: v } })}
      />

      <form onSubmit={save} noValidate>
        <fieldset disabled={!canEdit || busy} className="space-y-6">
          <Card>
            <CardHeader title="Business details" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="Business name" error={f.businessName.trim().length < 2 ? 'Enter your business name' : null}>{(p) => <Input {...p} value={f.businessName} onChange={(e) => set('businessName', e.target.value)} />}</Field>
              <Field label="Category">{(p) => <Input {...p} value={f.businessCategory} onChange={(e) => set('businessCategory', e.target.value)} />}</Field>
              <Field label="State">{(p) => <Input {...p} value={f.state} onChange={(e) => set('state', e.target.value)} />}</Field>
              <Field label="City">{(p) => <Input {...p} value={f.city} onChange={(e) => set('city', e.target.value)} />}</Field>
              <Field label="Business address" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} className="min-h-0" value={f.businessAddress} onChange={(e) => set('businessAddress', e.target.value)} />}</Field>
              <Field label="Store description" className="sm:col-span-2" hint={`${f.description.length}/1000 · Tell customers what you sell.`}>
                {(p) => <Textarea {...p} maxLength={1000} value={f.description} onChange={(e) => set('description', e.target.value)} />}
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Contact" description="How customers reach you" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="WhatsApp number" error={phoneErr(f.whatsappNumber)} hint="Powers the WhatsApp button on your storefront.">{(p) => <Input {...p} type="tel" placeholder="0803 123 4567" value={f.whatsappNumber} onChange={(e) => set('whatsappNumber', e.target.value)} />}</Field>
              <Field label="Contact phone" error={phoneErr(f.contactPhone)}>{(p) => <Input {...p} type="tel" value={f.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />}</Field>
              <Field label="Contact email" className="sm:col-span-2">{(p) => <Input {...p} type="email" value={f.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />}</Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Social links" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              {SOCIALS.map(([k, label, ph]) => (
                <Field key={k} label={label} error={handleErr(f.socialLinks[k])}>
                  {(p) => <Input {...p} placeholder={ph} value={f.socialLinks[k] ?? ''} onChange={(e) => set('socialLinks', { ...f.socialLinks, [k]: e.target.value.trim() })} />}
                </Field>
              ))}
              <Field label="Website" error={websiteErr}>{(p) => <Input {...p} type="url" placeholder="https://" value={f.socialLinks.website ?? ''} onChange={(e) => set('socialLinks', { ...f.socialLinks, website: e.target.value.trim() })} />}</Field>
            </div>
          </Card>
        </fieldset>

        {canEdit && (
          <div className="sticky bottom-0 mt-6 flex flex-col gap-3 border-t border-line bg-canvas/95 py-4 backdrop-blur sm:flex-row sm:items-center sm:justify-end">
            {msg && <Alert tone={msg.tone} className="sm:mr-auto">{msg.text}</Alert>}
            <Button type="button" variant="ghost" disabled={busy} onClick={() => { setF(fromProfile(profile.data!)); setMsg(null); }}>Discard changes</Button>
            <Button type="submit" loading={busy} disabled={invalid}>Save changes</Button>
          </div>
        )}
      </form>
    </div>
  );
}

/** Sell beyond stock: orders hold what exists, the rest waits for restock (filled oldest-first) and can't ship until then. */
function PreordersCard({ on, canEdit, onChange }: { on: boolean; canEdit: boolean; onChange: (v: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle(v: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api('/store/profile', { method: 'PATCH', body: { allowPreorders: v } });
      onChange(v);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mb-6">
      <CardHeader title="Sell beyond stock (pre-orders)" description="Keep taking orders when an item runs out, if you can get more for the customer." />
      <div className="space-y-3 p-5 text-sm">
        <label className="flex items-center gap-3">
          <input type="checkbox" className="size-4 accent-[var(--color-brand-600)]" checked={on} disabled={!canEdit || busy} onChange={(e) => void toggle(e.target.checked)} />
          <span className="font-medium">Allow pre-orders when stock runs out</span>
        </label>
        <p className="text-ink-3">Orders hold the stock you have; the rest is marked <em>awaiting stock</em>. When you add stock, waiting orders are filled oldest first. An order can&apos;t be dispatched until all of it is in stock. Your store shows &ldquo;Pre-order&rdquo; instead of &ldquo;Sold out&rdquo;.</p>
        {error && <Alert tone="bad">{error}</Alert>}
      </div>
    </Card>
  );
}
