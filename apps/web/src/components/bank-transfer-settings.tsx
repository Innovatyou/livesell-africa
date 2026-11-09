'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageLoading, Select, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money';
import { RECON_LABEL } from '@/lib/payment-labels';
import type { PendingTransfer, ReconReport, TransferAccount } from '@/lib/types';
import { useApi } from '@/lib/use-api';

const date = (s: string) => new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(s));

/** §13: the bank accounts customers transfer to. Account names are confirmed with the bank where a provider allows. */
export function BankTransferCard() {
  const { can } = useAuth();
  const canConfigure = can('payments:configure');
  const accounts = useApi<TransferAccount[]>('/payments/bank-accounts');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null);

  async function act(key: string, fn: () => Promise<unknown>, text: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'good', text });
      await accounts.reload();
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader title="Bank transfer" description="Customers can pay straight into your bank account. You confirm each transfer after checking your bank — orders are never marked paid from a receipt alone."
        action={canConfigure && !adding && (accounts.data?.filter((a) => a.isActive).length ?? 0) < 3 && <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>Add account</Button>} />
      <div className="space-y-3 p-5">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {accounts.error ? <ErrorState message={accounts.error} onRetry={accounts.reload} />
          : !accounts.data ? <PageLoading />
          : accounts.data.length === 0 && !adding ? <EmptyState title="No bank account added">Add the account customers should transfer to. It appears on their order page with your instructions.</EmptyState>
          : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {accounts.data.map((a) => (
                <li key={a.id} className="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium">{a.bankName} · <span className="font-mono">{a.accountNumber}</span></p>
                    <p className="text-ink-2">{a.accountName} {a.nameVerified ? <Badge tone="good">Name confirmed</Badge> : <Badge>Name not confirmed</Badge>} {a.isDefault && <Badge tone="brand">Shown first</Badge>} {!a.isActive && <Badge>Hidden</Badge>}</p>
                    {a.transferInstructions && <p className="text-[13px] text-ink-3">{a.transferInstructions}</p>}
                  </div>
                  {canConfigure && (
                    <div className="flex flex-wrap gap-2">
                      {!a.isDefault && a.isActive && <Button size="sm" variant="ghost" loading={busy === `d-${a.id}`} onClick={() => void act(`d-${a.id}`, () => api(`/payments/bank-accounts/${a.id}`, { method: 'PATCH', body: { isDefault: true } }), 'Shown first to customers.')}>Show first</Button>}
                      <Button size="sm" variant="ghost" loading={busy === `a-${a.id}`} onClick={() => void act(`a-${a.id}`, () => api(`/payments/bank-accounts/${a.id}`, { method: 'PATCH', body: { isActive: !a.isActive } }), a.isActive ? 'Hidden from customers.' : 'Shown to customers.')}>{a.isActive ? 'Hide' : 'Show'}</Button>
                      <Button size="sm" variant="ghost" loading={busy === `r-${a.id}`} onClick={() => { if (window.confirm(`Remove ${a.bankName} ••••${a.last4}?`)) void act(`r-${a.id}`, () => api(`/payments/bank-accounts/${a.id}`, { method: 'DELETE' }), 'Account removed.'); }}>Remove</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        {adding && <AddAccountForm onCancel={() => setAdding(false)} onSaved={async (a) => {
          setAdding(false);
          setMsg(a.nameMismatch ? { tone: 'warn', text: `Saved. The bank says this account belongs to “${a.accountName}” — customers will see that name.` } : { tone: 'good', text: 'Bank account added.' });
          await accounts.reload();
        }} />}
      </div>
    </Card>
  );
}

function AddAccountForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: (a: TransferAccount) => Promise<void> }) {
  const banks = useApi<Array<{ name: string; code: string }>>('/payments/banks?provider=paystack');
  const [f, setF] = useState({ bankCode: '', bankName: '', accountNumber: '', accountName: '', transferInstructions: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = f.bankName.trim().length >= 2 && /^\d{10}$/.test(f.accountNumber) && f.accountName.trim().length >= 2;
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const a = await api<TransferAccount>('/payments/bank-accounts', {
        method: 'POST',
        body: { ...(f.bankCode ? { bankCode: f.bankCode } : {}), bankName: f.bankName.trim(), accountNumber: f.accountNumber, accountName: f.accountName.trim(), ...(f.transferInstructions.trim() ? { transferInstructions: f.transferInstructions.trim() } : {}) },
      });
      await onSaved(a);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  const list = banks.data ?? [];
  return (
    <div className="grid gap-3 rounded-lg border border-line p-4">
      {error && <Alert tone="bad">{error}</Alert>}
      {list.length > 0 ? (
        <Field label="Bank">{(p) => <Select {...p} value={f.bankCode} onChange={(e) => { const b = list.find((x) => x.code === e.target.value); setF({ ...f, bankCode: e.target.value, bankName: b?.name ?? '' }); }}>
          <option value="">Choose your bank</option>{list.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}</Select>}</Field>
      ) : (
        <Field label="Bank name">{(p) => <Input {...p} value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} />}</Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Account number" error={f.accountNumber && !/^\d{10}$/.test(f.accountNumber) ? 'Enter the 10-digit account number' : null}>{(p) => <Input {...p} inputMode="numeric" maxLength={10} value={f.accountNumber} onChange={(e) => setF({ ...f, accountNumber: e.target.value.replace(/\D/g, '') })} />}</Field>
        <Field label="Account name" hint={f.bankCode ? 'We confirm it with the bank' : undefined}>{(p) => <Input {...p} maxLength={120} value={f.accountName} onChange={(e) => setF({ ...f, accountName: e.target.value })} />}</Field>
      </div>
      <Field label="Instructions for customers (optional)">{(p) => <Textarea {...p} rows={2} maxLength={500} value={f.transferInstructions} onChange={(e) => setF({ ...f, transferInstructions: e.target.value })} placeholder="Use your order number (LS-…) as the transfer description." />}</Field>
      <div className="flex gap-2"><Button loading={busy} disabled={!valid} onClick={() => void save()}>Save account</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </div>
  );
}

/** "Clearly identify unverified transfers" (§13): everything customers reported that nobody has checked yet. */
export function TransfersToCheckCard() {
  const pending = useApi<PendingTransfer[]>('/payments/transfers/pending');
  if (pending.error) return <Card><div className="p-5"><ErrorState message={pending.error} onRetry={pending.reload} /></div></Card>;
  if (!pending.data) return null;
  return (
    <Card>
      <CardHeader title="Transfers to check" description="Customers say they paid these by bank transfer. Open each order, check your bank, then verify or reject." />
      {pending.data.length === 0 ? <EmptyState title="Nothing to check">New transfer reports appear here.</EmptyState> : (
        <ul className="divide-y divide-line">
          {pending.data.map((t) => (
            <li key={t.id} className="flex flex-col gap-1 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span>{t.order ? <Link href={`/orders/${t.order.id}`} className="font-mono hover:text-brand-700">{t.order.reference}</Link> : t.reference} <span className="text-ink-3">· {t.payerName} · reported {date(t.createdAt)}</span>
                {t.order?.status === 'CANCELLED' && <Badge tone="bad" className="ml-2">Order cancelled</Badge>}{t.hasReceipt && <Badge className="ml-2">Receipt</Badge>}</span>
              <span className="font-semibold tabular">{formatMoney(t.grossMinor, t.currency)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Payment reconciliation (§12): the books against payments, refunds and orders. */
export function ReconciliationCard() {
  const r = useApi<ReconReport>('/payments/reconciliation');
  if (r.error) return <Card><div className="p-5"><ErrorState message={r.error} onRetry={r.reload} /></div></Card>;
  if (!r.data) return <Card><PageLoading /></Card>;
  const d = r.data;
  return (
    <Card>
      <CardHeader title="Reconciliation" description={`Checked ${date(d.checkedAt)}: every verified payment and refund against your books, orders and transfers.`}
        action={<Button size="sm" variant="ghost" onClick={() => void r.reload()}>Check again</Button>} />
      <div className="space-y-3 p-5">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-ink-3">Verified payments</dt><dd className="font-semibold tabular">{d.summary.verifiedPayments} · {formatMoney(d.summary.verifiedMinor)}</dd></div>
          <div><dt className="text-ink-3">Refunded</dt><dd className="font-semibold tabular">{formatMoney(d.summary.refundedMinor)}</dd></div>
          <div><dt className="text-ink-3">Unverified transfers</dt><dd className="font-semibold tabular">{d.summary.unverifiedTransfers} · {formatMoney(d.summary.unverifiedMinor)}</dd></div>
          <div><dt className="text-ink-3">Needs attention</dt><dd className="font-semibold tabular">{d.summary.errors + d.summary.warnings}</dd></div>
        </dl>
        {d.issues.length === 0 ? <Alert tone="good">Everything matches.</Alert> : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {d.issues.map((i, n) => (
              <li key={n} className="space-y-0.5 p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2"><Badge tone={i.severity === 'error' ? 'bad' : 'warn'}>{RECON_LABEL[i.type] ?? i.type}</Badge>
                  {i.orderId ? <Link href={`/orders/${i.orderId}`} className="font-mono hover:text-brand-700">{i.orderReference}</Link> : <span className="font-mono">{i.reference}</span>}</p>
                <p className="text-[13px] text-ink-2">{i.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
