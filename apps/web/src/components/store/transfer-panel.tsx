'use client';

import { useState } from 'react';
import { API_URL } from '@/lib/api';
import type { TrackedOrder } from '@/lib/types';

const RECEIPT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const MAX_BYTES = 5 * 1024 * 1024;
const when = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));
const CLAIM: Record<string, string> = { AWAITING_CHECK: 'Waiting for the seller to check their bank', VERIFIED: 'Confirmed by the seller', NOT_FOUND: 'The seller could not find this transfer' };

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${API_URL}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof json.message === 'string' ? json.message : Array.isArray(json.message) ? json.message[0] : 'Something went wrong. Please try again.');
  return json as T;
}

/**
 * Pay by direct bank transfer (MASTER-SPEC §13): the seller's account details, and a form to tell the seller once the
 * money is sent. The order is marked paid only after the seller confirms the money is in their bank account.
 */
export function TransferPanel({ order, token, total, onReported }: { order: TrackedOrder; token: string; total: string; onReported: () => void }) {
  const accounts = order.bankTransfer?.accounts ?? [];
  const claims = order.bankTransfer?.claims ?? [];
  const pending = claims.some((c) => c.status === 'AWAITING_CHECK');
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ payerName: '', payerBank: '', payerReference: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  if (!accounts.length && !claims.length) return null;
  const base = `/store/${encodeURIComponent(order.store.slug)}/orders/${encodeURIComponent(order.reference)}/transfer`;

  async function copy(v: string) {
    try { await navigator.clipboard.writeText(v); setCopied(v); setTimeout(() => setCopied(null), 1500); } catch { /* select manually */ }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let receiptKey: string | undefined;
      if (file) {
        if (!RECEIPT_TYPES.includes(file.type)) throw new Error('Upload a photo (PNG, JPG, WebP) or a PDF of your receipt.');
        if (file.size > MAX_BYTES) throw new Error('The receipt is too large (max 5 MB).');
        const p = await post<{ key: string; uploadUrl: string; headers: Record<string, string> }>(`${base}/receipt-url`, { token, contentType: file.type, contentLength: file.size });
        const put = await fetch(p.uploadUrl, { method: 'PUT', body: file, headers: p.headers }).catch(() => null);
        if (!put?.ok) throw new Error('The receipt could not be uploaded. Try again, or send without it.');
        receiptKey = p.key;
      }
      await post(base, {
        token, payerName: f.payerName.trim(), ...(f.payerBank.trim() ? { payerBank: f.payerBank.trim() } : {}),
        ...(f.payerReference.trim() ? { payerReference: f.payerReference.trim() } : {}), ...(receiptKey ? { receiptKey } : {}),
      });
      setOpen(false);
      setFile(null);
      onReported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface p-3 text-sm">
      {accounts.length > 0 && <>
        <p className="font-medium text-ink">Pay {total} by bank transfer</p>
        <ul className="space-y-2">
          {accounts.map((a) => (
            <li key={a.id} className="rounded-md bg-sunken p-3">
              <p className="text-[13px] text-ink-3">{a.bankName}</p>
              <p className="flex items-center gap-2 font-mono text-lg font-semibold tracking-wide">{a.accountNumber}
                <button type="button" onClick={() => void copy(a.accountNumber)} className="rounded border border-line px-2 py-0.5 font-sans text-[12px] font-medium">{copied === a.accountNumber ? 'Copied' : 'Copy'}</button></p>
              <p className="text-ink-2">{a.accountName}{a.nameVerified ? ' · name confirmed with the bank' : ''}</p>
              {a.instructions && <p className="mt-1 text-[13px] text-ink-3">{a.instructions}</p>}
            </li>
          ))}
        </ul>
        <p className="text-[13px] text-ink-3">Put <span className="font-mono font-medium text-ink">{order.reference}</span> in the transfer description, then tell the seller below.</p>
      </>}

      {claims.length > 0 && (
        <ul className="space-y-1 text-[13px]" aria-label="Your transfer reports">
          {claims.map((c) => <li key={c.reference} className={c.status === 'NOT_FOUND' ? 'text-bad' : c.status === 'VERIFIED' ? 'text-good' : 'text-ink-2'}>{when(c.reportedAt)} — {CLAIM[c.status]}</li>)}
        </ul>
      )}
      {pending && <p role="status" className="rounded-md bg-warn-bg px-3 py-2 text-[13px] text-warn">Your transfer has not been confirmed yet. The seller will check their bank account; your items stay reserved meanwhile.</p>}

      {accounts.length > 0 && !open && (
        <button type="button" onClick={() => setOpen(true)} className="h-11 rounded-[var(--radius-control)] border border-line px-4 text-sm font-semibold">{claims.length ? 'Report another transfer' : 'I’ve sent the money'}</button>
      )}
      {open && (
        <form onSubmit={submit} className="space-y-2">
          <label className="block text-[13px] text-ink-3" htmlFor="tr-name">Name on the account you paid from</label>
          <input id="tr-name" required minLength={2} maxLength={120} value={f.payerName} onChange={(e) => setF({ ...f, payerName: e.target.value })} className="h-11 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3" />
          <div className="grid gap-2 sm:grid-cols-2">
            <div><label className="block text-[13px] text-ink-3" htmlFor="tr-bank">Your bank (optional)</label>
              <input id="tr-bank" maxLength={80} value={f.payerBank} onChange={(e) => setF({ ...f, payerBank: e.target.value })} className="h-11 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3" /></div>
            <div><label className="block text-[13px] text-ink-3" htmlFor="tr-ref">Transfer reference (optional)</label>
              <input id="tr-ref" maxLength={80} value={f.payerReference} onChange={(e) => setF({ ...f, payerReference: e.target.value })} placeholder="Session ID on your receipt" className="h-11 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3" /></div>
          </div>
          <label className="block text-[13px] text-ink-3" htmlFor="tr-file">Receipt (optional, photo or PDF up to 5 MB)</label>
          <input id="tr-file" type="file" accept={RECEIPT_TYPES.join(',')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-[13px]" />
          {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || f.payerName.trim().length < 2} className="h-11 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Sending…' : 'Tell the seller'}</button>
            <button type="button" onClick={() => setOpen(false)} className="h-11 px-3 text-sm text-ink-3">Cancel</button>
          </div>
          <p className="text-[12px] text-ink-4">A receipt helps the seller find your payment, but the order is confirmed only when the money shows in their account.</p>
        </form>
      )}
    </div>
  );
}
