'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BankTransferCard, ReconciliationCard, TransfersToCheckCard } from '@/components/bank-transfer-settings';
import { PageHeader } from '@/components/page-header';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageLoading, Select, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatBps, formatMoney } from '@/lib/money';
import { PROVIDER_NAME, TXN_STATUS } from '@/lib/payment-labels';
import type { OnlineProvider, PaymentSettings, ProviderSetting, TransactionList } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const date = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));
const SOURCE: Record<string, string> = { trial: 'free during your trial', plan: 'your plan’s rate', seller_override: 'agreed rate', platform_default: 'platform rate' };

/** Where each provider keeps the things a seller pastes here. */
const GUIDE: Record<OnlineProvider, { keys: string; secretPh: string; publicPh?: string; publicRequired: boolean; webhook: string | null; split: string }> = {
  PAYSTACK: {
    keys: 'Paystack → Settings → API Keys & Webhooks.', secretPh: 'sk_live_…', publicPh: 'pk_live_…', publicRequired: true,
    webhook: null, split: 'No Paystack account needed: Paystack pays your bank account and LiveSell’s commission is taken automatically.',
  },
  FLUTTERWAVE: {
    keys: 'Flutterwave → Settings → API Keys.', secretPh: 'FLWSECK-…-X', publicPh: 'FLWPUBK-…-X', publicRequired: false,
    webhook: 'In Flutterwave → Settings → Webhooks, paste the webhook URL below, set a secret hash of your choice and paste the same hash here.',
    split: 'No Flutterwave account needed: Flutterwave pays your bank account and LiveSell’s commission is taken automatically.',
  },
  BACHS: {
    keys: 'Bachs Developer Portal → API keys. The key needs the payments:read, payments:write and refunds:write scopes.', secretPh: 'sk_live_…', publicRequired: false,
    webhook: 'In the Bachs Developer Portal → Webhooks, add the webhook URL below as an endpoint and paste its signing secret here.',
    split: '',
  },
};

export default function PaymentsSettingsPage() {
  const { can } = useAuth();
  const allowed = can('payments:read');
  const settings = useApi<PaymentSettings>(allowed ? '/payments/settings' : null);
  const txns = useApi<TransactionList>(allowed ? '/payments/transactions?pageSize=10' : null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  if (!allowed) return <Card><EmptyState title="You don’t have access to payments" /></Card>;
  if (settings.error) return <ErrorState message={settings.error} onRetry={settings.reload} />;
  if (!settings.data) return <PageLoading />;
  const s = settings.data;
  const anyEnabled = s.providers.some((p) => p.provider.enabled);
  const done = async (text: string) => { setMsg({ tone: 'good', text }); await settings.reload(); };
  const failed = (e: unknown) => setMsg({ tone: 'bad', text: errorMessage(e) });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Payments" description="Take card, bank transfer and USSD payments online. An order is marked paid only when the provider confirms the payment to our server." />
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!anyEnabled && <Alert tone="info" title="Online payments are not switched on yet">LiveSell is finishing the online payment setup. You can already take bank transfers below.</Alert>}
      {s.commission && <p className="text-sm text-ink-2">LiveSell commission on online sales: <span className="font-medium">{formatBps(s.commission.bps)}</span> ({SOURCE[s.commission.source] ?? s.commission.source}).</p>}
      {anyEnabled && !s.defaultProvider && <Alert tone="info">Connect a provider below. Customers pay with your default provider; you can connect more than one and switch.</Alert>}

      <TransfersToCheckCard />

      {s.providers.map((p) => (
        <ProviderCard key={p.provider.code} p={p} isDefault={s.defaultProvider === p.provider.code} canConfigure={can('payments:configure')} onDone={done} onError={failed} />
      ))}

      <BankTransferCard />
      <ReconciliationCard />

      <Card>
        <CardHeader title="Recent online payments" />
        {txns.error ? <div className="p-5"><ErrorState message={txns.error} onRetry={txns.reload} /></div>
          : !txns.data ? <PageLoading />
          : txns.data.items.length === 0 ? <EmptyState title="No online payments yet">Payments customers make online appear here with fees and what you receive.</EmptyState>
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-[12px] uppercase tracking-wide text-ink-3">
                  <tr className="border-b border-line"><th className="px-5 py-2.5 font-medium">Order</th><th className="px-5 py-2.5 font-medium">Via</th><th className="px-5 py-2.5 font-medium">Status</th><th className="px-5 py-2.5 text-right font-medium">Amount</th><th className="px-5 py-2.5 text-right font-medium">You receive</th><th className="px-5 py-2.5 text-right font-medium">When</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {txns.data.items.map((t) => (
                    <tr key={t.id}>
                      <td className="px-5 py-3">{t.order ? <Link href={`/orders/${t.order.id}`} className="font-mono hover:text-brand-700">{t.order.reference}</Link> : '—'}{t.refunds.some((r) => r.status === 'SUCCEEDED') && <Badge className="ml-2">Refunded</Badge>}{t.status === 'SUCCEEDED' && t.failureReason && <Badge tone="warn" className="ml-2">Needs refund</Badge>}</td>
                      <td className="px-5 py-3 text-ink-2">{PROVIDER_NAME[t.provider] ?? t.provider}</td>
                      <td className="px-5 py-3"><Badge tone={TXN_STATUS[t.status][1]}>{TXN_STATUS[t.status][0]}</Badge></td>
                      <td className="px-5 py-3 text-right tabular">{formatMoney(t.grossMinor, t.currency)}</td>
                      <td className="px-5 py-3 text-right tabular">{t.sellerProceedsMinor ? formatMoney(t.sellerProceedsMinor, t.currency) : '—'}</td>
                      <td className="px-5 py-3 text-right text-ink-3">{date(t.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </div>
  );
}

function ProviderCard({ p, isDefault, canConfigure, onDone, onError }: { p: ProviderSetting; isDefault: boolean; canConfigure: boolean; onDone: (msg: string) => Promise<void>; onError: (e: unknown) => void }) {
  const code = p.provider.code;
  const slug = code.toLowerCase();
  const name = p.provider.name;
  const acc = p.account;
  const g = GUIDE[code];
  const [mode, setMode] = useState<'direct' | 'split' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const formMode = mode ?? (acc?.mode === 'SPLIT' ? 'split' : 'direct');
  const showForm = canConfigure && p.provider.enabled && (mode !== null || !acc);

  async function act(key: string, fn: () => Promise<unknown>, text: string) {
    setBusy(key);
    try {
      await fn();
      await onDone(text);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader title={name}
        description={!p.provider.enabled ? 'Not available yet.' : !acc ? 'Not connected.' : acc.mode === 'DIRECT' ? `Payments go straight into your own ${name} account.` : `Payments go through LiveSell’s ${name} account and settle to your bank.`}
        action={acc && <span className="flex flex-wrap gap-1">{isDefault && <Badge tone="brand">Default</Badge>}{acc.testMode && <Badge tone="warn">Test mode</Badge>}<Badge tone={acc.isActive ? 'good' : 'neutral'}>{acc.isActive ? 'On' : 'Off'}</Badge></span>} />
      {acc && (
        <dl className="space-y-2 p-5 text-sm">
          {acc.mode === 'DIRECT' && <>
            {acc.publicKey && <div className="flex justify-between gap-3"><dt className="text-ink-3">Public key</dt><dd className="truncate font-mono text-[12px]">{acc.publicKey}</dd></div>}
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Secret key</dt><dd>Saved, encrypted — never shown again</dd></div>
          </>}
          {acc.bankAccount && <div className="flex justify-between gap-3"><dt className="text-ink-3">Settles to</dt><dd>{acc.bankAccount.bankName} · {acc.bankAccount.accountName} · ••••{acc.bankAccount.last4}</dd></div>}
          {acc.lastVerifiedAt && <div className="flex justify-between gap-3"><dt className="text-ink-3">Checked with {name}</dt><dd>{date(acc.lastVerifiedAt)}</dd></div>}
          {!p.capabilities.multipleRefunds && <div className="flex justify-between gap-3"><dt className="text-ink-3">Refunds</dt><dd>One refund per payment</dd></div>}
          {acc.webhookUrl && (
            <div className="space-y-1 border-t border-line pt-3">
              <dt className="text-ink-3">Webhook URL</dt>
              <dd className="flex flex-wrap items-center gap-2"><code className="break-all rounded bg-sunken px-2 py-1 text-[12px]">{acc.webhookUrl}</code>
                <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(acc.webhookUrl!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => undefined); }}>{copied ? 'Copied' : 'Copy'}</Button></dd>
              <dd className="text-[12px] text-ink-3">
                {g.webhook ?? `Paste it into ${name} → Settings → API Keys & Webhooks.`}{' '}
                {p.capabilities.webhookSecret === 'separate' && (acc.hasWebhookSecret ? 'Webhook secret saved.' : 'No webhook secret saved yet.')}{' '}
                Optional — {p.webhooksEnabled ? 'it makes confirmations instant.' : 'not active yet.'} Payments are confirmed by checking with {name} either way.
              </dd>
            </div>
          )}
        </dl>
      )}
      {acc && canConfigure && (
        <div className="flex flex-wrap gap-2 border-t border-line p-5">
          {!isDefault && acc.isActive && p.provider.enabled && <Button size="sm" loading={busy === 'default'} onClick={() => void act('default', () => api(`/payments/settings/${slug}/default`, { method: 'POST', body: {} }), `Customers now pay with ${name}.`)}>Make default</Button>}
          <Button size="sm" variant="secondary" loading={busy === 'toggle'} onClick={() => void act('toggle', () => api(`/payments/settings/${slug}/active`, { method: 'POST', body: { isActive: !acc.isActive } }), acc.isActive ? `${name} is off.` : `${name} is on.`)}>{acc.isActive ? 'Turn off' : 'Turn on'}</Button>
          {p.provider.enabled && <Button size="sm" variant="ghost" onClick={() => setMode(acc.mode === 'SPLIT' ? 'split' : 'direct')}>Change account</Button>}
        </div>
      )}
      {showForm && (
        <div className="space-y-4 border-t border-line p-5">
          {p.capabilities.split && (
            <div role="radiogroup" aria-label={`${name} settlement`} className="grid gap-2 sm:grid-cols-2">
              {([['direct', `My own ${name} account`, `You already have a ${name} business account. Money lands there directly.`], ['split', 'Get paid through LiveSell', g.split]] as const).map(([k, title, text]) => (
                <button key={k} type="button" role="radio" aria-checked={formMode === k} disabled={k === 'split' && !p.splitAvailable} onClick={() => setMode(k)}
                  className={cx('rounded-lg border p-3 text-left text-sm disabled:opacity-50', formMode === k ? 'border-brand-500 bg-brand-50/40' : 'border-line')}>
                  <span className="block font-medium">{title}</span><span className="text-[13px] text-ink-3">{k === 'split' && !p.splitAvailable ? 'Not available yet.' : text}</span>
                </button>
              ))}
            </div>
          )}
          {formMode === 'direct' || !p.capabilities.split
            ? <DirectForm p={p} onSaved={async () => { setMode(null); await onDone(`${name} connected.`); }} onCancel={acc ? () => setMode(null) : undefined} />
            : <SplitForm p={p} onSaved={async () => { setMode(null); await onDone('Bank account confirmed.'); }} onCancel={acc ? () => setMode(null) : undefined} />}
        </div>
      )}
    </Card>
  );
}

function DirectForm({ p, onSaved, onCancel }: { p: ProviderSetting; onSaved: () => Promise<void>; onCancel?: () => void }) {
  const code = p.provider.code;
  const g = GUIDE[code];
  const [sk, setSk] = useState('');
  const [pk, setPk] = useState('');
  const [wh, setWh] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skOk = sk.trim().length >= 16;
  const pkOk = !g.publicRequired || pk.trim().length >= 10;
  const whOk = !wh || wh.trim().length >= 16;
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/payments/settings/${code.toLowerCase()}/direct`, { method: 'PUT', body: { secretKey: sk.trim(), ...(pk.trim() ? { publicKey: pk.trim() } : {}), ...(wh.trim() ? { webhookSecret: wh.trim() } : {}) } });
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-3">
      {error && <Alert tone="bad">{error}</Alert>}
      <p className="text-[13px] text-ink-3">Find your keys in {g.keys} We check the secret key with {p.provider.name}, store it encrypted, and never show it again.</p>
      <Field label="Secret key">{(f) => <Input {...f} type="password" autoComplete="off" spellCheck={false} value={sk} onChange={(e) => setSk(e.target.value)} placeholder={g.secretPh} />}</Field>
      {g.publicPh && <Field label={g.publicRequired ? 'Public key' : 'Public key (optional)'}>{(f) => <Input {...f} autoComplete="off" spellCheck={false} value={pk} onChange={(e) => setPk(e.target.value)} placeholder={g.publicPh} />}</Field>}
      {p.capabilities.webhookSecret === 'separate' && (
        <Field label="Webhook secret (optional)" hint={p.account?.hasWebhookSecret ? 'Leave empty to keep the saved one' : 'At least 16 characters'} error={!whOk ? 'At least 16 characters' : null}>
          {(f) => <Input {...f} type="password" autoComplete="off" spellCheck={false} value={wh} onChange={(e) => setWh(e.target.value)} />}
        </Field>
      )}
      <div className="flex gap-2"><Button loading={busy} disabled={!skOk || !pkOk || !whOk} onClick={() => void save()}>Connect {p.provider.name}</Button>{onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}</div>
    </div>
  );
}

function SplitForm({ p, onSaved, onCancel }: { p: ProviderSetting; onSaved: () => Promise<void>; onCancel?: () => void }) {
  const slug = p.provider.code.toLowerCase();
  const banks = useApi<Array<{ name: string; code: string }>>(`/payments/banks?provider=${slug}`);
  const [bankCode, setBankCode] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = !!bankCode && /^\d{10}$/.test(account);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/payments/settings/${slug}/split`, { method: 'PUT', body: { bankCode, accountNumber: account } });
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  if (banks.error) return <ErrorState message={banks.error} onRetry={banks.reload} />;
  if (!banks.data) return <PageLoading label="Loading banks" />;
  if (banks.data.length === 0) return <Alert tone="info">The bank list isn’t available right now. Try again in a few minutes.</Alert>;
  return (
    <div className="grid gap-3">
      {error && <Alert tone="bad">{error}</Alert>}
      <p className="text-[13px] text-ink-3">We confirm the account name with your bank before saving. The account must be in your business’s name.</p>
      <Field label="Bank">{(f) => <Select {...f} value={bankCode} onChange={(e) => setBankCode(e.target.value)}><option value="">Choose your bank</option>{banks.data!.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}</Select>}</Field>
      <Field label="Account number" error={account && !/^\d{10}$/.test(account) ? 'Enter the 10-digit account number' : null}>{(f) => <Input {...f} inputMode="numeric" maxLength={10} value={account} onChange={(e) => setAccount(e.target.value.replace(/\D/g, ''))} />}</Field>
      <div className="flex gap-2"><Button loading={busy} disabled={!valid} onClick={() => void save()}>Confirm bank account</Button>{onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}</div>
    </div>
  );
}
