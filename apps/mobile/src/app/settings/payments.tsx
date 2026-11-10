import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { Badge, Button, Card, Choice, ErrorBox, Field, Loading, Muted, Notice, Row, Screen, c } from '@/components/ui';
import { api } from '@/lib/api';
import { useApi, useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

type Code = 'PAYSTACK' | 'FLUTTERWAVE' | 'BACHS';
interface ProviderSetting {
  provider: { code: Code; name: string; enabled: boolean };
  splitAvailable: boolean;
  capabilities: { split: boolean; webhookSecret: 'secret_key' | 'separate' };
  account: null | { mode: 'DIRECT' | 'SPLIT'; isActive: boolean; testMode: boolean; publicKey: string | null; hasWebhookSecret: boolean; bankAccount: { bankName: string; accountName: string; last4: string } | null; webhookUrl: string | null };
}
interface Settings { defaultProvider: Code | null; commission: { bps: number } | null; providers: ProviderSetting[] }
interface TransferAccount { id: string; bankName: string; accountName: string; last4: string; isActive: boolean; isDefault: boolean; transferInstructions: string | null; nameMismatch?: boolean }
interface Bank { name: string; code: string }

const GUIDE: Record<Code, { keys: string; secretPh: string; publicPh?: string; publicRequired: boolean }> = {
  PAYSTACK: { keys: 'Paystack app or dashboard → Settings → API Keys & Webhooks', secretPh: 'sk_live_…', publicPh: 'pk_live_…', publicRequired: true },
  FLUTTERWAVE: { keys: 'Flutterwave → Settings → API Keys', secretPh: 'FLWSECK-…-X', publicPh: 'FLWPUBK-…-X', publicRequired: false },
  BACHS: { keys: 'Bachs Developer Portal → API keys (payments:read, payments:write, refunds:write)', secretPh: 'sk_live_…', publicRequired: false },
};

/** Card / transfer / USSD providers and the bank accounts customers transfer to — everything the web payments page does. */
export default function PaymentsSettings() {
  useTheme();
  const { can } = useAuth();
  const settings = useApi<Settings>(can('payments:read') ? '/payments/settings' : null);
  const accounts = useApi<TransferAccount[]>(can('payments:read') ? '/payments/bank-accounts' : null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  if (!can('payments:read')) return <Screen><Notice tone="warn">Your role can’t see payment settings.</Notice></Screen>;
  if (settings.error) return <Screen><ErrorBox message={settings.error} onRetry={settings.reload} /></Screen>;
  if (!settings.data || !accounts.data) return <Loading />;
  const s = settings.data;
  const configure = can('payments:configure');
  const done = async (text: string) => { setMsg({ tone: 'good', text }); await Promise.all([settings.reload(), accounts.reload()]); };
  const fail = (e: unknown) => setMsg({ tone: 'bad', text: (e as Error).message });

  return (
    <Screen refreshing={settings.loading} onRefresh={() => { void settings.reload(); void accounts.reload(); }}>
      {msg ? <Notice tone={msg.tone}>{msg.text}</Notice> : null}
      <Muted>An order becomes paid only when the provider confirms the money to LiveSell’s server — never from a screenshot.</Muted>
      {s.commission ? <Muted>LiveSell commission on online sales: {(s.commission.bps / 100).toFixed(2)}%.</Muted> : null}
      {s.providers.map((p) => <ProviderCard key={p.provider.code} p={p} isDefault={s.defaultProvider === p.provider.code} configure={configure} onDone={done} onError={fail} />)}
      <TransferAccounts list={accounts.data} configure={configure} onDone={done} onError={fail} />
    </Screen>
  );
}

function ProviderCard({ p, isDefault, configure, onDone, onError }: { p: ProviderSetting; isDefault: boolean; configure: boolean; onDone: (t: string) => Promise<void>; onError: (e: unknown) => void }) {
  const { code, name, enabled } = p.provider;
  const slug = code.toLowerCase();
  const acc = p.account;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'direct' | 'split'>(acc?.mode === 'SPLIT' ? 'split' : 'direct');
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, text: string) => {
    setBusy(key);
    try { await fn(); setOpen(false); await onDone(text); } catch (e) { onError(e); } finally { setBusy(null); }
  };
  return (
    <Card style={{ gap: 8 }}>
      <Row>
        <Text style={{ fontWeight: '700', color: c.ink, fontSize: 16 }}>{name}</Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {isDefault ? <Badge tone="good">Default</Badge> : null}
          {acc?.testMode ? <Badge tone="warn">Test</Badge> : null}
          {acc ? <Badge tone={acc.isActive ? 'good' : 'neutral'}>{acc.isActive ? 'On' : 'Off'}</Badge> : null}
        </View>
      </Row>
      <Muted>{!enabled ? 'Not available yet.' : !acc ? 'Not connected.' : acc.mode === 'DIRECT' ? `Money goes straight into your own ${name} account.` : `${name} pays your bank${acc.bankAccount ? ` (${acc.bankAccount.bankName} ••••${acc.bankAccount.last4})` : ''}; LiveSell’s commission is taken automatically.`}</Muted>
      {acc?.webhookUrl && p.capabilities.webhookSecret === 'separate' ? <Muted>Webhook URL (optional, makes confirmations instant): {acc.webhookUrl}</Muted> : null}
      {configure && enabled && acc && !open ? (
        <Row style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
          {!isDefault && acc.isActive ? <Button title="Make default" loading={busy === 'def'} onPress={() => void run('def', () => api(`/payments/settings/${slug}/default`, { method: 'POST', body: {} }), `Customers now pay with ${name}.`)} /> : null}
          <Button variant="secondary" title={acc.isActive ? 'Turn off' : 'Turn on'} loading={busy === 'act'} onPress={() => void run('act', () => api(`/payments/settings/${slug}/active`, { method: 'POST', body: { isActive: !acc.isActive } }), acc.isActive ? `${name} is off.` : `${name} is on.`)} />
          <Button variant="secondary" title="Change account" onPress={() => setOpen(true)} />
        </Row>
      ) : null}
      {configure && enabled && (!acc || open) ? (
        <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10 }}>
          {p.capabilities.split ? <Choice label={`${name} settlement`} value={mode} onChange={setMode} options={[['direct', `My own ${name} account`], ['split', p.splitAvailable ? 'Get paid through LiveSell' : 'Through LiveSell (soon)']]} /> : null}
          {mode === 'split' && p.capabilities.split
            ? (p.splitAvailable ? <SplitForm slug={slug} busy={busy === 'save'} onSave={(body) => void run('save', () => api(`/payments/settings/${slug}/split`, { method: 'PUT', body }), 'Bank account confirmed.')} />
              : <Muted>Not available yet; connect your own account for now.</Muted>)
            : <DirectForm code={code} name={name} separateSecret={p.capabilities.webhookSecret === 'separate'} busy={busy === 'save'} onSave={(body) => void run('save', () => api(`/payments/settings/${slug}/direct`, { method: 'PUT', body }), `${name} connected.`)} />}
          {acc ? <Button variant="secondary" title="Cancel" onPress={() => setOpen(false)} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

function DirectForm({ code, name, separateSecret, busy, onSave }: { code: Code; name: string; separateSecret: boolean; busy: boolean; onSave: (b: Record<string, string>) => void }) {
  const g = GUIDE[code];
  const [sk, setSk] = useState('');
  const [pk, setPk] = useState('');
  const [wh, setWh] = useState('');
  const ok = sk.trim().length >= 16 && (!g.publicRequired || pk.trim().length >= 10) && (!wh || wh.trim().length >= 16);
  return (
    <>
      <Muted>Find your keys in {g.keys}. We check the secret key with {name}, store it encrypted and never show it again.</Muted>
      <Field label="Secret key" password value={sk} onChangeText={setSk} autoCapitalize="none" autoCorrect={false} placeholder={g.secretPh} />
      {g.publicPh ? <Field label={g.publicRequired ? 'Public key' : 'Public key (optional)'} value={pk} onChangeText={setPk} autoCapitalize="none" autoCorrect={false} placeholder={g.publicPh} /> : null}
      {separateSecret ? <Field label="Webhook secret (optional)" password value={wh} onChangeText={setWh} autoCapitalize="none" error={wh && wh.trim().length < 16 ? 'At least 16 characters' : null} /> : null}
      <Button title={`Connect ${name}`} disabled={!ok} loading={busy} onPress={() => onSave({ secretKey: sk.trim(), ...(pk.trim() ? { publicKey: pk.trim() } : {}), ...(wh.trim() ? { webhookSecret: wh.trim() } : {}) })} />
    </>
  );
}

/** Searchable bank list from the provider (all Nigerian banks and fintechs). */
function BankPicker({ provider, value, onChange, allowManual }: { provider: string; value: Bank | null; onChange: (b: Bank) => void; allowManual?: boolean }) {
  const banks = useApi<Bank[]>(`/payments/banks?provider=${provider}`);
  const [q, setQ] = useState('');
  // Transfer accounts don't need the bank code: if the list can't load, the seller types the bank's name.
  if (allowManual && (banks.error || (banks.data && banks.data.length === 0))) {
    return <Field label="Bank name" value={value?.name ?? q} onChangeText={(v) => { setQ(v); onChange({ name: v, code: '' }); }} placeholder="Guaranty Trust Bank" />;
  }
  if (banks.error) return <ErrorBox message={banks.error} onRetry={banks.reload} />;
  if (!banks.data) return <Loading />;
  if (value) return <Row><Text style={{ color: c.ink, flex: 1 }}>{value.name}</Text><Button variant="secondary" title="Change" onPress={() => onChange(null as unknown as Bank)} /></Row>;
  const hits = banks.data.filter((b) => b.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8);
  return (
    <View style={{ gap: 6 }}>
      <Field label="Bank" value={q} onChangeText={setQ} placeholder="Type to search, e.g. GTBank, Opay, Moniepoint" />
      {q.trim() ? hits.map((b) => (
        <Pressable key={b.code} onPress={() => onChange(b)} accessibilityRole="button" style={{ paddingVertical: 8 }}><Text style={{ color: c.brand, fontWeight: '600' }}>{b.name}</Text></Pressable>
      )) : null}
      {q.trim() && hits.length === 0 ? <Muted>No bank matches “{q.trim()}”.</Muted> : null}
    </View>
  );
}

function SplitForm({ slug, busy, onSave }: { slug: string; busy: boolean; onSave: (b: { bankCode: string; accountNumber: string }) => void }) {
  const [bank, setBank] = useState<Bank | null>(null);
  const [acct, setAcct] = useState('');
  return (
    <>
      <Muted>We confirm the account name with your bank before saving. It must be in your business’s name.</Muted>
      <BankPicker provider={slug} value={bank} onChange={(b) => setBank(b && b.code ? b : null)} />
      <Field label="Account number" value={acct} onChangeText={(v) => setAcct(v.replace(/\D/g, '').slice(0, 10))} keyboardType="number-pad" error={acct && acct.length !== 10 ? '10 digits' : null} />
      <Button title="Confirm bank account" disabled={!bank || acct.length !== 10} loading={busy} onPress={() => bank && onSave({ bankCode: bank.code, accountNumber: acct })} />
    </>
  );
}

function TransferAccounts({ list, configure, onDone, onError }: { list: TransferAccount[]; configure: boolean; onDone: (t: string) => Promise<void>; onError: (e: unknown) => void }) {
  const [adding, setAdding] = useState(false);
  const [bank, setBank] = useState<Bank | null>(null);
  const [f, setF] = useState({ accountNumber: '', accountName: '', instructions: 'Use your order number (LS-…) as the transfer description.' });
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, text: string) => {
    setBusy(key);
    try { await fn(); await onDone(text); return true; } catch (e) { onError(e); return false; } finally { setBusy(null); }
  };
  const valid = !!bank && /^\d{10}$/.test(f.accountNumber) && f.accountName.trim().length >= 2;
  return (
    <Card style={{ gap: 8 }}>
      <Text style={{ fontWeight: '700', color: c.ink, fontSize: 16 }}>Bank transfer accounts</Text>
      <Muted>Customers who pay by transfer see your default account. You confirm each transfer in the order once the money is in.</Muted>
      {list.length === 0 ? <Muted>No account yet.</Muted> : list.map((a) => (
        <View key={a.id} style={{ gap: 6, paddingVertical: 6, borderTopWidth: 1, borderTopColor: c.line }}>
          <Row><Text style={{ color: c.ink, flex: 1 }}>{a.bankName} · {a.accountName} · ••••{a.last4}</Text>{a.isDefault ? <Badge tone="good">Default</Badge> : !a.isActive ? <Badge>Off</Badge> : null}</Row>
          {a.nameMismatch ? <Notice tone="warn">The bank’s account name doesn’t match your business name.</Notice> : null}
          {configure ? (
            <Row style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
              {!a.isDefault && a.isActive ? <Button variant="secondary" title="Make default" loading={busy === `d${a.id}`} onPress={() => void run(`d${a.id}`, () => api(`/payments/bank-accounts/${a.id}`, { method: 'PATCH', body: { isDefault: true } }), 'Default account changed.')} /> : null}
              <Button variant="secondary" title={a.isActive ? 'Turn off' : 'Turn on'} loading={busy === `a${a.id}`} onPress={() => void run(`a${a.id}`, () => api(`/payments/bank-accounts/${a.id}`, { method: 'PATCH', body: { isActive: !a.isActive } }), a.isActive ? 'Account turned off.' : 'Account turned on.')} />
              <Button variant="danger" title="Remove" loading={busy === `r${a.id}`} onPress={() => Alert.alert('Remove account?', `${a.bankName} ••••${a.last4}`, [{ text: 'Keep', style: 'cancel' }, { text: 'Remove', style: 'destructive', onPress: () => void run(`r${a.id}`, () => api(`/payments/bank-accounts/${a.id}`, { method: 'DELETE' }), 'Account removed.') }])} />
            </Row>
          ) : null}
        </View>
      ))}
      {configure && !adding ? <Button variant="secondary" title="+ Add bank account" onPress={() => setAdding(true)} /> : null}
      {configure && adding ? (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: c.line, paddingTop: 10 }}>
          <BankPicker provider="paystack" allowManual value={bank} onChange={(b) => setBank(b && (b.code || b.name.trim().length >= 2) ? b : null)} />
          <Field label="Account number" value={f.accountNumber} onChangeText={(v) => setF({ ...f, accountNumber: v.replace(/\D/g, '').slice(0, 10) })} keyboardType="number-pad" />
          <Field label="Account name" value={f.accountName} onChangeText={(v) => setF({ ...f, accountName: v })} autoCapitalize="characters" placeholder="ADA FASHION LTD" />
          <Field label="Instructions for customers" value={f.instructions} onChangeText={(v) => setF({ ...f, instructions: v })} multiline maxLength={500} />
          <Button title="Save account" disabled={!valid} loading={busy === 'add'} onPress={() => void run('add', () => api('/payments/bank-accounts', { method: 'POST', body: {
            ...(bank!.code ? { bankCode: bank!.code } : {}), bankName: bank!.name.trim(), accountNumber: f.accountNumber, accountName: f.accountName.trim(), ...(f.instructions.trim() ? { transferInstructions: f.instructions.trim() } : {}), isDefault: list.length === 0,
          } }), 'Bank account saved.').then((ok) => { if (ok) { setAdding(false); setBank(null); setF({ ...f, accountNumber: '', accountName: '' }); } })} />
          <Button variant="secondary" title="Cancel" onPress={() => setAdding(false)} />
        </View>
      ) : null}
    </Card>
  );
}
