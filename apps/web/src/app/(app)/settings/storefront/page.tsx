'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, Card, CardHeader, ErrorState, Field, PageLoading, Textarea, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { StorefrontSettings } from '@/lib/types';
import { uploadFile } from '@/lib/upload';
import { useApi } from '@/lib/use-api';

export default function StorefrontSettingsPage() {
  const { can, workspace, reload: reloadSession } = useAuth();
  const canEdit = can('store:manage');
  const s = useApi<StorefrontSettings>('/storefront');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const cover = useRef<HTMLInputElement>(null);

  useEffect(() => { if (s.data) setInstructions(s.data.orderInstructions ?? ''); }, [s.data]);
  if (s.error) return <ErrorState message={s.error} onRetry={s.reload} />;
  if (!s.data) return <PageLoading />;
  const d = s.data;
  const ready = d.readiness.every((r) => r.done);
  const path = `/store/${workspace?.slug}`;

  async function run(key: string, fn: () => Promise<StorefrontSettings>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      s.setData(await fn());
      setMsg({ tone: 'good', text: ok });
      void reloadSession();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function pickCover(file?: File) {
    if (!file) return;
    await run('cover', async () => {
      const key = await uploadFile('/storefront/cover/upload-url', file, ['image/png', 'image/jpeg', 'image/webp'], 3 * 1024 * 1024);
      return api<StorefrontSettings>('/storefront/cover', { method: 'PUT', body: { key } });
    }, 'Cover image updated.');
    if (cover.current) cover.current.value = '';
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Storefront" description="Your shop at livesell.africa — built for customers arriving from TikTok, Instagram and WhatsApp." />
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!canEdit && <Alert tone="info">Only the owner can change the storefront.</Alert>}

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2">Visibility <Badge tone={d.isPublished ? 'good' : 'neutral'}>{d.isPublished ? 'Published' : 'Not published'}</Badge></span>}
          description={d.isPublished ? 'Customers can browse your products and order on WhatsApp.' : 'Only you can see it until you publish.'}
          action={canEdit && (d.isPublished
            ? <Button variant="secondary" size="sm" loading={busy === 'pub'} onClick={() => void run('pub', () => api('/storefront/unpublish', { method: 'POST', body: {} }), 'Storefront hidden.')}>Unpublish</Button>
            : <Button size="sm" loading={busy === 'pub'} disabled={!ready} onClick={() => void run('pub', () => api('/storefront/publish', { method: 'POST', body: {} }), 'Your storefront is live.')}>Publish</Button>)}
        />
        <div className="space-y-4 p-5">
          <ul className="space-y-2">
            {d.readiness.map((r) => (
              <li key={r.key} className="flex items-center gap-2 text-sm">
                <span aria-hidden className={cx('grid size-5 place-items-center rounded-full text-[11px] text-white', r.done ? 'bg-brand-600' : 'bg-line-strong')}>{r.done ? '✓' : ''}</span>
                <span className={r.done ? 'text-ink-3' : 'text-ink'}>{r.label}</span>
                {!r.done && (r.key === 'product' ? <Link href="/products" className="text-brand-700 hover:underline">Products</Link> : <Link href="/settings/store" className="text-brand-700 hover:underline">Store profile</Link>)}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2 rounded-lg bg-sunken p-3 sm:flex-row sm:items-center">
            <code className="flex-1 truncate text-sm">{d.publicUrl}</code>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(d.publicUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}>{copied ? 'Copied' : 'Copy link'}</Button>
              {d.isPublished && <Link href={path} target="_blank" className="inline-flex h-8 items-center rounded-[var(--radius-control)] px-3 text-[13px] font-medium text-brand-700 hover:bg-brand-50">Open ↗</Link>}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Cover image" description="Wide banner at the top of your store. PNG, JPG or WebP up to 3 MB." />
        <div className="space-y-3 p-5">
          <div className="aspect-[3/1] overflow-hidden rounded-lg border border-line bg-sunken">
            {d.coverUrl ? <img src={d.coverUrl} alt="Store cover" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-sm text-ink-4">No cover yet</div>}
          </div>
          {canEdit && <div className="flex gap-2">
            <input ref={cover} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => void pickCover(e.target.files?.[0])} />
            <Button size="sm" variant="secondary" loading={busy === 'cover'} onClick={() => cover.current?.click()}>{d.coverUrl ? 'Replace cover' : 'Upload cover'}</Button>
            {d.coverUrl && <Button size="sm" variant="ghost" loading={busy === 'rmcover'} onClick={() => void run('rmcover', () => api('/storefront/cover', { method: 'DELETE' }), 'Cover removed.')}>Remove</Button>}
          </div>}
        </div>
      </Card>

      <Card>
        <CardHeader title="Look and ordering" />
        <fieldset disabled={!canEdit || !!busy} className="space-y-5 p-5">
          <div>
            <p className="mb-2 text-[13px] font-medium text-ink-2">Accent colour</p>
            <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap gap-2">
              {d.accentColours.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={(d.theme.accentColor ?? d.accentColours[0]) === c} aria-label={c}
                  onClick={() => void run('accent', () => api('/storefront', { method: 'PATCH', body: { accentColor: c } }), 'Accent colour updated.')}
                  className={cx('size-9 rounded-full ring-offset-2 transition', (d.theme.accentColor ?? d.accentColours[0]) === c ? 'ring-2 ring-ink' : 'hover:scale-105')} style={{ background: c }} />
              ))}
            </div>
          </div>
          <Field label="How to order" hint={`${instructions.length}/500 · Shown on your store and product pages, e.g. “Send the product code to our WhatsApp to order.”`}>
            {(p) => <Textarea {...p} rows={3} maxLength={500} value={instructions} onChange={(e) => setInstructions(e.target.value)} />}
          </Field>
          {canEdit && <Button size="sm" loading={busy === 'instr'} disabled={instructions === (d.orderInstructions ?? '')} onClick={() => void run('instr', () => api('/storefront', { method: 'PATCH', body: { orderInstructions: instructions.trim() || null } }), 'Ordering instructions saved.')}>Save instructions</Button>}
        </fieldset>
      </Card>
    </div>
  );
}
