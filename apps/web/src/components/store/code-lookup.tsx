'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { API_URL } from '@/lib/api';

/** "Saw BAG001 in the live? Enter it here." — looks the code up and opens that product. */
export function CodeLookup({ slug }: { slug: string }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'missing' | 'error'>('idle');
  async function go(e: React.FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9-]{2,20}$/.test(c)) return setState('missing');
    setState('busy');
    try {
      const res = await fetch(`${API_URL}/api/v1/store/${encodeURIComponent(slug)}/code/${encodeURIComponent(c)}`);
      if (res.status === 404) return setState('missing');
      if (!res.ok) return setState('error');
      const p = (await res.json()) as { slug: string };
      router.push(`/store/${slug}/p/${p.slug}`);
    } catch {
      setState('error');
    }
  }
  return (
    <form onSubmit={go} className="rounded-[var(--radius-card)] border border-dashed border-[var(--accent)] bg-surface p-4">
      <label htmlFor="code" className="block text-sm font-medium">Saw a product code in a live? Enter it here</label>
      <div className="mt-2 flex gap-2">
        <input id="code" value={code} onChange={(e) => { setCode(e.target.value); setState('idle'); }} placeholder="e.g. BAG001" autoCapitalize="characters"
          className="h-11 flex-1 rounded-[var(--radius-control)] border border-line-strong px-3 font-mono uppercase tracking-wide focus:border-[var(--accent)] focus:outline-none" />
        <button className="h-11 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-sm font-medium text-white disabled:opacity-60" disabled={state === 'busy' || !code.trim()}>{state === 'busy' ? 'Finding…' : 'Find'}</button>
      </div>
      {state === 'missing' && <p role="status" className="mt-2 text-sm text-bad">No product with that code in this store. Check the code and try again.</p>}
      {state === 'error' && <p role="status" className="mt-2 text-sm text-bad">Couldn&apos;t look that up right now. Please try again.</p>}
    </form>
  );
}
