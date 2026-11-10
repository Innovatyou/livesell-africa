import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, Switch, Text, View } from 'react-native';
import { Button, Card, Choice, ErrorBox, Field, Loading, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { toKobo } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Channel { id: string; type: string; name: string; handle: string | null; isActive: boolean }
interface Product { id: string; name: string; productCode: string }
type Platform_ = 'TIKTOK_LIVE' | 'INSTAGRAM_LIVE' | 'FACEBOOK_LIVE' | 'YOUTUBE_LIVE' | 'WHATSAPP' | 'OTHER';
const PLATFORMS: Array<[Platform_, string]> = [['TIKTOK_LIVE', 'TikTok'], ['INSTAGRAM_LIVE', 'Instagram'], ['FACEBOOK_LIVE', 'Facebook'], ['YOUTUBE_LIVE', 'YouTube'], ['WHATSAPP', 'WhatsApp'], ['OTHER', 'Other']];
const label = (t: string) => PLATFORMS.find(([k]) => k === t)?.[1] ?? 'Other';

/**
 * Plan a live sale from the phone: where you'll go live, when (now or later), and optionally which products you'll
 * show, with live-only prices. LiveSell doesn't stream: go live in TikTok / Instagram as usual and record orders here.
 */
export default function NewLiveSession() {
  useTheme();
  const { can } = useAuth();
  const channels = useApi<Channel[]>('/sales-channels');
  const [search, setSearch] = useState('');
  const products = useApi<{ items: Product[] }>(`/products?status=ACTIVE&pageSize=30${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`);
  const [platform, setPlatform] = useState<Platform_>('TIKTOK_LIVE');
  const [handle, setHandle] = useState('');
  const [title, setTitle] = useState('');
  const [now, setNow] = useState(true);
  const [at, setAt] = useState(() => new Date(Date.now() + 60 * 60_000));
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);
  const [instructions, setInstructions] = useState('Comment the product code (e.g. BAG001) to order. We’ll send you a payment link.');
  const [chosen, setChosen] = useState<Record<string, { name: string; code: string; livePrice: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!can('live:manage')) return <Screen><Notice tone="warn">Your role can run sessions but not create them. Ask the owner or a manager.</Notice></Screen>;
  if (channels.error) return <Screen><ErrorBox message={channels.error} onRetry={channels.reload} /></Screen>;
  if (!channels.data) return <Loading />;

  const existing = channels.data.find((ch) => ch.type === platform && ch.isActive);
  const handleOk = !handle.trim() || /^@?[A-Za-z0-9._-]{1,60}$/.test(handle.trim());
  const pricesOk = Object.values(chosen).every((p) => !p.livePrice.trim() || toKobo(p.livePrice) !== null);
  const valid = title.trim().length >= 2 && handleOk && pricesOk && (now || at.getTime() > Date.now() - 60_000);

  const onPick = (e: DateTimePickerEvent, d?: Date) => {
    const mode = picker;
    setPicker(Platform.OS === 'ios' ? picker : null);
    if (e.type !== 'set' || !d) return;
    const next = new Date(at);
    if (mode === 'date') next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    else next.setHours(d.getHours(), d.getMinutes(), 0, 0);
    setAt(next);
    if (Platform.OS === 'android' && mode === 'date') setPicker('time'); // date, then time
  };

  async function create() {
    setBusy(true);
    setError(null);
    try {
      // One sales channel per platform; created the first time it's used.
      const channelId = existing?.id ?? (await api<Channel>('/sales-channels', { method: 'POST', body: {
        type: platform, name: handle.trim() ? `${label(platform)} — ${handle.trim().startsWith('@') ? handle.trim() : `@${handle.trim()}`}` : label(platform),
        ...(handle.trim() ? { handle: handle.trim() } : {}),
      } })).id;
      const s = await api<{ id: string }>('/live-sessions', { method: 'POST', body: {
        title: title.trim(), channelId, scheduledAt: (now ? new Date() : at).toISOString(),
        ...(instructions.trim() ? { orderInstructions: instructions.trim() } : {}),
        products: Object.entries(chosen).map(([productId, p]) => ({ productId, sessionPriceMinor: p.livePrice.trim() ? String(toKobo(p.livePrice)) : null })),
      } });
      if (now) await api(`/live-sessions/${s.id}/start`, { method: 'POST' });
      router.replace(`/live/${s.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const fmt = (d: Date) => new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(d);

  return (
    <Screen>
      <Notice tone="info">LiveSell doesn’t stream video. Go live on TikTok, Instagram or Facebook as usual; record orders here as viewers comment product codes.</Notice>
      {error ? <Notice tone="bad">{error}</Notice> : null}

      <Card style={{ gap: 10 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Where are you going live?</Text>
        <Choice<Platform_> label="Platform" value={platform} onChange={setPlatform} options={PLATFORMS} />
        {existing ? <Muted>Using your channel “{existing.name}”.</Muted> : (
          <Field label={`Your ${label(platform)} handle (optional)`} value={handle} onChangeText={setHandle} autoCapitalize="none" placeholder="@adafashion" error={handleOk ? null : 'Letters, numbers, . _ - only'} />
        )}
        <Field label="Title" value={title} onChangeText={setTitle} placeholder="Friday Night Bag Drop" maxLength={140} />
      </Card>

      <Card style={{ gap: 10 }}>
        <Row><Text style={{ color: c.ink, flex: 1, fontWeight: '700' }}>Start now</Text>
          <Switch value={now} onValueChange={setNow} trackColor={{ true: c.brand, false: c.line }} thumbColor={c.surface} accessibilityLabel="Start now" /></Row>
        {now ? <Muted>The session goes live as soon as you create it.</Muted> : (
          <>
            <Pressable onPress={() => setPicker('date')} accessibilityRole="button" accessibilityLabel="Change date and time">
              <View style={{ padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface }}>
                <Muted>Starts</Muted><Text style={{ color: c.ink, fontSize: 16, fontWeight: '600' }}>{fmt(at)}</Text>
              </View>
            </Pressable>
            <Row style={{ justifyContent: 'flex-start' }}>
              <Button variant="secondary" title="Change date" onPress={() => setPicker('date')} />
              <Button variant="secondary" title="Change time" onPress={() => setPicker('time')} />
            </Row>
            {picker ? <DateTimePicker value={at} mode={picker} minimumDate={picker === 'date' ? new Date() : undefined} onChange={onPick} themeVariant={c.dark ? 'dark' : 'light'} /> : null}
          </>
        )}
      </Card>

      <Card style={{ gap: 10 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>How viewers order</Text>
        <Field label="Shown on your store page and order messages" value={instructions} onChangeText={setInstructions} multiline maxLength={500} style={{ minHeight: 70, textAlignVertical: 'top' }} />
      </Card>

      <Card style={{ gap: 10 }}>
        <Text style={{ fontWeight: '700', color: c.ink }}>Products you’ll show (optional)</Text>
        <Muted>They appear at the top of the live console. Set a live-only price to run a flash deal; leave it empty to use the normal price. Any product code can still be ordered.</Muted>
        <Field label="Search products" value={search} onChangeText={setSearch} placeholder="Name or code" autoCapitalize="none" />
        {products.error ? <ErrorBox message={products.error} onRetry={products.reload} /> : !products.data ? <Loading /> : products.data.items.map((p) => {
          const on = !!chosen[p.id];
          return (
            <View key={p.id} style={{ gap: 6 }}>
              <Pressable onPress={() => setChosen((cur) => { const n = { ...cur }; if (on) delete n[p.id]; else n[p.id] = { name: p.name, code: p.productCode, livePrice: '' }; return n; })}
                accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                <Row><Text style={{ color: c.ink, flex: 1 }} numberOfLines={1}><Text style={{ fontWeight: '700' }}>{p.productCode}</Text> · {p.name}</Text><Text style={{ color: on ? c.brand : c.ink3, fontWeight: '700' }}>{on ? '✓ Added' : 'Add'}</Text></Row>
              </Pressable>
              {on ? <Field label={`Live price for ${p.productCode} (₦, optional)`} value={chosen[p.id].livePrice} keyboardType="decimal-pad"
                onChangeText={(v) => setChosen((cur) => ({ ...cur, [p.id]: { ...cur[p.id], livePrice: v } }))}
                error={chosen[p.id].livePrice.trim() && toKobo(chosen[p.id].livePrice) === null ? 'Enter an amount like 15000' : null} /> : null}
            </View>
          );
        })}
        {products.data && products.data.items.length === 0 ? <Muted>No active products{search ? ' match' : ' yet'}.</Muted> : null}
      </Card>

      <Button title={now ? 'Go live now' : 'Schedule session'} onPress={() => void create()} loading={busy} disabled={!valid} />
    </Screen>
  );
}
