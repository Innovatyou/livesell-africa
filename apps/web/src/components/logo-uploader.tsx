'use client';

import { useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { uploadFile } from '@/lib/upload';
import { Alert, Button } from './ui';

const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX = 2 * 1024 * 1024;

export function LogoUploader({ logoUrl, businessName, canEdit, onChange }: {
  logoUrl: string | null; businessName: string; canEdit: boolean; onChange: (url: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setOk(null);
    setBusy('upload');
    try {
      const key = await uploadFile('/store/logo/upload-url', file, TYPES, MAX);
      const r = await api<{ logoUrl: string }>('/store/logo', { method: 'PUT', body: { key } });
      onChange(r.logoUrl);
      setOk('Logo updated.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setError(null);
    setOk(null);
    setBusy('remove');
    try {
      await api('/store/logo', { method: 'DELETE' });
      onChange(null);
      setOk('Logo removed.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const initials = businessName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <div className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-2xl border border-line bg-sunken">
          {logoUrl ? (
            <img src={logoUrl} alt={`${businessName} logo`} className="size-full object-cover" />
          ) : (
            <span className="text-lg font-semibold text-ink-3" aria-hidden>{initials}</span>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-ink-2">PNG, JPG or WebP, up to 2 MB. A square image works best.</p>
          {canEdit ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <input ref={input} type="file" accept={TYPES.join(',')} className="sr-only" id="logo-file" onChange={(e) => void pick(e.target.files?.[0])} />
              <Button size="sm" variant="secondary" loading={busy === 'upload'} disabled={!!busy} onClick={() => input.current?.click()}>
                {logoUrl ? 'Replace logo' : 'Upload logo'}
              </Button>
              {logoUrl && <Button size="sm" variant="ghost" loading={busy === 'remove'} disabled={!!busy} onClick={() => void remove()}>Remove</Button>}
            </div>
          ) : (
            <p className="mt-1 text-[13px] text-ink-3">Only the owner can change the logo.</p>
          )}
        </div>
      </div>
      {error && <Alert tone="bad">{error}</Alert>}
      {ok && <Alert tone="good">{ok}</Alert>}
    </div>
  );
}
