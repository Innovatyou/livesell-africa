import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, ScrollView, Switch, Text, View } from 'react-native';
import { Badge, Button, Card, ErrorBox, Field, Loading, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { money, toKobo } from '@/lib/format';
import { useTheme } from '@/lib/theme';

interface Variant { id: string; name: string; attributes: Record<string, string>; priceMinor: string; isActive: boolean; inventory: { onHand: number; reserved: number; available: number } }
interface Product { id: string; name: string; productCode: string; description: string | null; status: string; media: Array<{ key: string; type: 'image' | 'video'; url: string }>; variants: Variant[] }
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Create (`new`) or edit a product: photos, name, code, price, status, stock. Products with options keep their options. */
export default function ProductScreen() {
  useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const { can } = useAuth();
  const res = useApi<Product>(isNew ? null : `/products/${id}`);
  const [f, setF] = useState({ name: '', code: '', price: '', stock: '', description: '', active: true });
  const [media, setMedia] = useState<Array<{ key: string; type: 'image' | 'video'; url: string }>>([]);
  const [adjust, setAdjust] = useState<Record<string, string>>({});
  // New products: the code follows the name ("Red Leather Handbag" → BAG007) until the seller types their own.
  const [codeTouched, setCodeTouched] = useState(!isNew);
  // Options (new products): e.g. Size = S, M, L and Colour = Black, Brown → one variant per combination.
  const [opts, setOpts] = useState({ on: false, name1: 'Size', values1: '', name2: '', values2: '' });
  const [comboStock, setComboStock] = useState<Record<string, string>>({});
  const [variantPrice, setVariantPrice] = useState<Record<string, string>>({});

  useEffect(() => {
    if (codeTouched || f.name.trim().length < 2) return;
    const t = setTimeout(() => {
      api<{ productCode: string }>(`/products/code-suggestion?name=${encodeURIComponent(f.name.trim())}`).then((r) => setF((cur) => ({ ...cur, code: r.productCode }))).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [f.name, codeTouched]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (!res.data) return;
    const p = res.data;
    setF({ name: p.name, code: p.productCode, price: p.variants.length === 1 ? String(BigInt(p.variants[0].priceMinor) / 100n) + (BigInt(p.variants[0].priceMinor) % 100n ? `.${(BigInt(p.variants[0].priceMinor) % 100n).toString().padStart(2, '0')}` : '') : '', stock: '', description: p.description ?? '', active: p.status === 'ACTIVE' });
    setMedia(p.media);
  }, [res.data]);

  if (!can('products:write') && isNew) return <Screen><Notice tone="warn">Your role can’t add products.</Notice></Screen>;
  if (!isNew && res.error) return <Screen><ErrorBox message={res.error} onRetry={res.reload} /></Screen>;
  if (!isNew && !res.data) return <Loading />;
  const p = res.data;
  const single = isNew || (p?.variants.length ?? 0) === 1;
  const price = toKobo(f.price);
  const codeOk = /^[A-Z0-9][A-Z0-9-]{1,19}$/.test(f.code);
  const stock = f.stock === '' ? 0 : Number(f.stock);
  const list = (s: string) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 20);
  const combos: Array<Record<string, string>> = !opts.on || !opts.name1.trim() || !list(opts.values1).length ? []
    : list(opts.values1).flatMap((a) => (opts.name2.trim() && list(opts.values2).length ? list(opts.values2).map((b) => ({ [opts.name1.trim()]: a, [opts.name2.trim()]: b })) : [{ [opts.name1.trim()]: a }]));
  const comboKey = (a: Record<string, string>) => Object.values(a).join(' / ');
  const comboStockOk = combos.every((a) => { const v = comboStock[comboKey(a)] ?? ''; return v === '' || (Number.isInteger(Number(v)) && Number(v) >= 0); });
  const variantPricesOk = single || !p || p.variants.every((v) => !variantPrice[v.id] || toKobo(variantPrice[v.id]) !== null);
  const valid = f.name.trim().length >= 2 && (codeOk || (isNew && !f.code)) && (!single || price !== null) && Number.isInteger(stock) && stock >= 0
    && (!opts.on || (combos.length > 0 && combos.length <= 100 && comboStockOk)) && variantPricesOk;

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'good', text: ok });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function addPhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return setMsg({ tone: 'bad', text: 'Allow photo access in Settings to add pictures.' });
    const pick = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (pick.canceled || !pick.assets?.[0]) return;
    const asset = pick.assets[0];
    await run('photo', async () => {
      const blob = await (await fetch(asset.uri)).blob();
      const type = asset.mimeType ?? blob.type;
      if (!IMAGE_TYPES.includes(type)) throw new Error('Use a JPG, PNG or WebP photo.');
      if (blob.size > 5 * 1024 * 1024) throw new Error('Photos can be up to 5 MB.');
      const up = await api<{ uploadUrl: string; key: string; headers: Record<string, string> }>('/products/media/upload-url', { method: 'POST', body: { contentType: type, contentLength: blob.size } });
      const put = await fetch(up.uploadUrl, { method: 'PUT', body: blob, headers: up.headers });
      if (!put.ok) throw new Error('The photo could not be uploaded. Try again.');
      setMedia((m) => [...m, { key: up.key, type: 'image', url: asset.uri }]);
    }, 'Photo added — save to keep it.');
  }

  async function save() {
    const mediaBody = media.map((m) => ({ key: m.key, type: m.type }));
    if (isNew) {
      const created = await api<{ id: string }>('/products', { method: 'POST', body: {
        name: f.name.trim(), ...(f.code ? { productCode: f.code } : {}), description: f.description.trim() || undefined, status: f.active ? 'ACTIVE' : 'DRAFT', media: mediaBody,
        variants: opts.on
          ? combos.map((a) => ({ attributes: a, priceMinor: price, initialStock: Number(comboStock[comboKey(a)] || 0) }))
          : [{ attributes: {}, priceMinor: price, initialStock: stock }],
      } });
      router.replace(`/products/${created.id}`);
      return;
    }
    await api(`/products/${id}`, { method: 'PATCH', body: {
      name: f.name.trim(), productCode: f.code, description: f.description.trim() || null, status: f.active ? 'ACTIVE' : 'DRAFT', media: mediaBody,
      ...(single && p ? { variants: [{ id: p.variants[0].id, attributes: p.variants[0].attributes, priceMinor: price }] } : {}),
      ...(!single && p ? { variants: p.variants.map((v) => ({ id: v.id, attributes: v.attributes, priceMinor: variantPrice[v.id] ? toKobo(variantPrice[v.id]) : v.priceMinor })) } : {}),
    } });
    await res.reload();
  }

  return (
    <Screen>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <Card style={{ gap: 10 }}>
        <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
          {media.filter((m) => m.type === 'image').map((m) => (
            <View key={m.key}>
              <Image source={{ uri: m.url }} style={{ width: 96, height: 96, borderRadius: 10, backgroundColor: c.line }} accessibilityLabel="Product photo" />
              <Text onPress={() => setMedia((x) => x.filter((y) => y.key !== m.key))} style={{ color: c.bad, fontSize: 12, textAlign: 'center' }}>Remove</Text>
            </View>
          ))}
        </ScrollView>
        {can('products:write') ? <Button variant="secondary" title="Add photo" loading={busy === 'photo'} onPress={() => void addPhoto()} /> : null}
        <Field label="Name" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} />
        <Field label="Product code" value={f.code} onChangeText={(v) => { setCodeTouched(true); setF({ ...f, code: v.toUpperCase().replace(/\s+/g, '') }); }} autoCapitalize="characters" placeholder="BAG001" error={f.code && !codeOk ? '2–20 letters, digits or hyphens' : null} />
        {isNew && !codeTouched ? <Muted>Made from the name. Customers comment or send this code to order; you can change it.</Muted> : null}
        {single ? <Field label={opts.on ? 'Price for every option (₦)' : 'Price (₦)'} value={f.price} onChangeText={(v) => setF({ ...f, price: v })} keyboardType="decimal-pad" error={f.price && price === null ? 'Enter an amount' : null} /> : (
          <View style={{ gap: 8 }}>
            <Text style={{ fontWeight: '600', color: c.ink2 }}>Prices per option (₦)</Text>
            {p!.variants.map((v) => (
              <Field key={v.id} label={`${v.name} (now ${money(v.priceMinor)})`} value={variantPrice[v.id] ?? ''} onChangeText={(x) => setVariantPrice({ ...variantPrice, [v.id]: x })} keyboardType="decimal-pad" placeholder="Leave empty to keep"
                error={variantPrice[v.id] && toKobo(variantPrice[v.id]) === null ? 'Enter an amount' : null} />
            ))}
          </View>
        )}
        {isNew ? (
          <>
            <Row><Text style={{ color: c.ink, flex: 1 }}>This product has options (size, colour…)</Text><Switch value={opts.on} onValueChange={(v) => setOpts({ ...opts, on: v })} /></Row>
            {opts.on ? (
              <View style={{ gap: 8 }}>
                <Field label="Option name" value={opts.name1} onChangeText={(v) => setOpts({ ...opts, name1: v })} placeholder="Size" />
                <Field label="Choices, separated by commas" value={opts.values1} onChangeText={(v) => setOpts({ ...opts, values1: v })} placeholder="S, M, L, XL" />
                <Field label="Second option (optional)" value={opts.name2} onChangeText={(v) => setOpts({ ...opts, name2: v })} placeholder="Colour" />
                {opts.name2.trim() ? <Field label="Its choices" value={opts.values2} onChangeText={(v) => setOpts({ ...opts, values2: v })} placeholder="Black, Brown" /> : null}
                {combos.length > 100 ? <Notice tone="bad">Up to 100 combinations.</Notice> : null}
                {combos.length ? <Text style={{ fontWeight: '600', color: c.ink2 }}>Stock for each ({combos.length})</Text> : null}
                {combos.slice(0, 100).map((a) => (
                  <Field key={comboKey(a)} label={comboKey(a)} value={comboStock[comboKey(a)] ?? ''} onChangeText={(v) => setComboStock({ ...comboStock, [comboKey(a)]: v })} keyboardType="number-pad" placeholder="0" />
                ))}
              </View>
            ) : <Field label="Stock" value={f.stock} onChangeText={(v) => setF({ ...f, stock: v })} keyboardType="number-pad" placeholder="0" />}
          </>
        ) : null}
        <Field label="Description (optional)" value={f.description} onChangeText={(v) => setF({ ...f, description: v })} multiline style={{ minHeight: 80, textAlignVertical: 'top', paddingTop: 10 }} />
        <Row><Text style={{ color: c.ink }}>Show on my store</Text><Switch value={f.active} onValueChange={(v) => setF({ ...f, active: v })} /></Row>
        {can('products:write') ? <Button title={isNew ? 'Add product' : 'Save'} disabled={!valid} loading={busy === 'save'} onPress={() => void run('save', save, isNew ? 'Product added.' : 'Saved.')} /> : null}
      </Card>

      {!isNew && p ? (
        <Card style={{ gap: 10 }}>
          <Text style={{ fontWeight: '700', color: c.ink }}>Stock</Text>
          {p.variants.map((v) => {
            const n = Number(adjust[v.id] ?? '');
            const ok = Number.isInteger(n) && n > 0;
            return (
              <View key={v.id} style={{ gap: 6 }}>
                <Row><Text style={{ color: c.ink }}>{v.name === 'Default' ? p.name : v.name} · {money(v.priceMinor)}</Text><Badge tone={v.inventory.available > 0 ? 'good' : 'bad'}>{`${v.inventory.available} free · ${v.inventory.reserved} held`}</Badge></Row>
                {can('inventory:write') ? (
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
                    <View style={{ flex: 1 }}><Field label="Quantity" value={adjust[v.id] ?? ''} onChangeText={(x) => setAdjust({ ...adjust, [v.id]: x })} keyboardType="number-pad" /></View>
                    <View style={{ flex: 1 }}><Button variant="secondary" title="Add" disabled={!ok} loading={busy === `add-${v.id}`} onPress={() => void run(`add-${v.id}`, async () => { await api(`/inventory/variants/${v.id}/adjust`, { method: 'POST', body: { mode: 'add', quantity: n, reason: 'Restocked from the mobile app', type: 'RESTOCK' } }); setAdjust({ ...adjust, [v.id]: '' }); await res.reload(); }, 'Stock added.')} /></View>
                    <View style={{ flex: 1 }}><Button variant="secondary" title="Remove" disabled={!ok} loading={busy === `rm-${v.id}`} onPress={() => void run(`rm-${v.id}`, async () => { await api(`/inventory/variants/${v.id}/adjust`, { method: 'POST', body: { mode: 'remove', quantity: n, reason: 'Corrected from the mobile app', type: 'ADJUSTMENT' } }); setAdjust({ ...adjust, [v.id]: '' }); await res.reload(); }, 'Stock removed.')} /></View>
                  </View>
                ) : null}
              </View>
            );
          })}
        </Card>
      ) : null}
    </Screen>
  );
}
