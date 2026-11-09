'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatMoney, koboToNairaInput, nairaToKobo } from '@/lib/money';
import type { LiveSession, Member, Page, ProductListItem, SalesChannel } from '@/lib/types';
import { useApi } from '@/lib/use-api';
import { Alert, Button, Card, CardHeader, Field, Input, Select, Textarea } from './ui';

const LIVE_TYPES: Array<[string, string]> = [['TIKTOK_LIVE', 'TikTok Live'], ['INSTAGRAM_LIVE', 'Instagram Live'], ['FACEBOOK_LIVE', 'Facebook Live'], ['YOUTUBE_LIVE', 'YouTube Live'], ['WHATSAPP', 'WhatsApp'], ['OTHER', 'Other']];

/** datetime-local value in the browser's zone ⇄ ISO */
const toLocal = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };

export function LiveSessionForm({ session, onSaved }: { session?: LiveSession; onSaved?: (s: LiveSession) => void }) {
  const router = useRouter();
  const channels = useApi<SalesChannel[]>('/sales-channels');
  const members = useApi<Member[]>('/workspace/members');
  const products = useApi<Page<ProductListItem>>('/products?status=ACTIVE&pageSize=100&sort=name');
  const [title, setTitle] = useState(session?.title ?? '');
  const [channelId, setChannelId] = useState(session?.channel.id ?? '');
  const [scheduledAt, setScheduledAt] = useState(toLocal(session?.scheduledAt ?? new Date(Date.now() + 3_600_000).toISOString()));
  const [description, setDescription] = useState(session?.description ?? '');
  const [instructions, setInstructions] = useState(session?.orderInstructions ?? 'Comment the product code (e.g. BAG001) and send it to our WhatsApp to order.');
  const [picked, setPicked] = useState<Array<{ productId: string; price: string }>>(session?.products.map((p) => ({ productId: p.productId, price: koboToNairaInput(p.sessionPriceMinor) })) ?? []);
  const [mods, setMods] = useState<string[]>(session?.moderators.map((m) => m.memberId) ?? []);
  const [newChannel, setNewChannel] = useState<{ type: string; name: string; handle: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = new Map((products.data?.items ?? []).map((p) => [p.id, p]));
  const invalid = title.trim().length < 2 || !channelId || !scheduledAt || picked.some((p) => p.price && !nairaToKobo(p.price));

  async function createChannel() {
    if (!newChannel) return;
    try {
      const ch = await api<SalesChannel>('/sales-channels', { method: 'POST', body: { type: newChannel.type, name: newChannel.name.trim(), ...(newChannel.handle.trim() ? { handle: newChannel.handle.trim() } : {}) } });
      await channels.reload();
      setChannelId(ch.id);
      setNewChannel(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      title: title.trim(), channelId, scheduledAt: new Date(scheduledAt).toISOString(), description: description.trim(), orderInstructions: instructions.trim(),
      products: picked.map((p) => ({ productId: p.productId, sessionPriceMinor: p.price ? nairaToKobo(p.price) : null })), moderatorIds: mods,
    };
    try {
      const s = session
        ? await api<LiveSession>(`/live-sessions/${session.id}`, { method: 'PATCH', body })
        : await api<LiveSession>('/live-sessions', { method: 'POST', body });
      if (onSaved) onSaved(s); else router.push(`/live/${s.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="bad">{error}</Alert>}
      <Card>
        <CardHeader title="Session" />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Title" className="sm:col-span-2">{(p) => <Input {...p} placeholder="Friday Night Bag Drop" value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <Field label="Channel">
            {(p) => (
              <div className="flex gap-2">
                <Select {...p} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                  <option value="">Choose…</option>
                  {channels.data?.filter((c) => c.isActive && c.type !== 'STOREFRONT' && c.type !== 'MANUAL').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
                <Button type="button" variant="secondary" onClick={() => setNewChannel({ type: 'TIKTOK_LIVE', name: '', handle: '' })}>New</Button>
              </div>
            )}
          </Field>
          <Field label="Starts">{(p) => <Input {...p} type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />}</Field>
          {newChannel && (
            <div className="grid gap-2 rounded-lg border border-line p-3 sm:col-span-2 sm:grid-cols-[160px_1fr_1fr_auto] sm:items-end">
              <Field label="Platform">{(p) => <Select {...p} value={newChannel.type} onChange={(e) => setNewChannel({ ...newChannel, type: e.target.value })}>{LIVE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
              <Field label="Name">{(p) => <Input {...p} placeholder="TikTok — main account" value={newChannel.name} onChange={(e) => setNewChannel({ ...newChannel, name: e.target.value })} />}</Field>
              <Field label="Handle (optional)">{(p) => <Input {...p} placeholder="@yourshop" value={newChannel.handle} onChange={(e) => setNewChannel({ ...newChannel, handle: e.target.value })} />}</Field>
              <div className="flex gap-2"><Button type="button" size="sm" disabled={newChannel.name.trim().length < 2} onClick={() => void createChannel()}>Add</Button><Button type="button" size="sm" variant="ghost" onClick={() => setNewChannel(null)}>Cancel</Button></div>
            </div>
          )}
          <Field label="Description (optional)" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <Field label="How viewers order" className="sm:col-span-2" hint="Say this in the live and pin it in the comments.">{(p) => <Textarea {...p} rows={2} maxLength={500} value={instructions} onChange={(e) => setInstructions(e.target.value)} />}</Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Products to promote" description="Optional live-only price applies to every variant of that product." />
        <div className="space-y-3 p-5">
          <Select aria-label="Add a product" value="" onChange={(e) => e.target.value && setPicked([...picked, { productId: e.target.value, price: '' }])}>
            <option value="">+ Add a product…</option>
            {products.data?.items.filter((p) => !picked.some((x) => x.productId === p.id)).map((p) => <option key={p.id} value={p.id}>{p.productCode} · {p.name}</option>)}
          </Select>
          {products.data && products.data.items.length === 0 && <p className="text-sm text-ink-3">No active products yet. Activate products to promote them.</p>}
          <ul className="divide-y divide-line">
            {picked.map((x, i) => {
              const p = byId.get(x.productId);
              return (
                <li key={x.productId} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1"><span className="font-mono text-[12px] text-ink-3">{p?.productCode}</span> {p?.name ?? 'Product'} <span className="text-ink-3">· {p?.priceMin ? formatMoney(p.priceMin) : ''}</span></span>
                  <Input aria-label="Live price" className="h-8 w-32" inputMode="decimal" placeholder="Live price ₦" value={x.price} onChange={(e) => setPicked(picked.map((y, j) => (j === i ? { ...y, price: e.target.value } : y)))} />
                  <Button size="sm" variant="ghost" onClick={() => setPicked(picked.filter((_, j) => j !== i))}>Remove</Button>
                </li>
              );
            })}
          </ul>
        </div>
      </Card>

      <Card>
        <CardHeader title="Moderators" description="Team members who take orders during the live." />
        <div className="flex flex-wrap gap-3 p-5 text-sm">
          {members.data ? members.data.filter((m) => m.status === 'ACTIVE').map((m) => (
            <label key={m.id} className="flex items-center gap-2"><input type="checkbox" checked={mods.includes(m.id)} onChange={(e) => setMods(e.target.checked ? [...mods, m.id] : mods.filter((x) => x !== m.id))} /> {m.user.fullName} <span className="text-ink-3">· {m.role.name}</span></label>
          )) : <span className="text-ink-3">{members.error ? 'Only the owner can assign moderators.' : 'Loading…'}</span>}
        </div>
      </Card>

      <div className="flex justify-end"><Button loading={busy} disabled={invalid} onClick={() => void save()}>{session ? 'Save session' : 'Schedule session'}</Button></div>
    </div>
  );
}
