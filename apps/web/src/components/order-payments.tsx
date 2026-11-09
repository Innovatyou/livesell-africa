'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Dialog } from '@/components/dialog';
import { Alert, Badge, Button, Card, CardHeader, Field, Input } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatMoney, koboToNairaInput, nairaToKobo, toMinor } from '@/lib/money';
import { whatsappLink } from '@/lib/storefront';
import { ATTENTION, FAIL_REASON, OPEN_TXN, PROVIDER_NAME, REFUND_STATUS, refundable, txnLabel } from '@/lib/payment-labels';
import { uploadFile } from '@/lib/upload';
import type { Order, PaymentLink, PaymentTxn } from '@/lib/types';

/** Online payment for one order: link to send, server-side check, transactions with fees/commission, refunds. */
export function OrderPayments({ order: o, onChanged }: { order: Order; onChanged: () => Promise<unknown> }) {
  const { can } = useAuth();
  const [link, setLink] = useState<PaymentLink | null>(null);
  const [email, setEmail] = useState('');
  const [askEmail, setAskEmail] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'info'; text: string } | null>(null);
  const [refundFor, setRefundFor] = useState<PaymentTxn | null>(null);
  const [copied, setCopied] = useState(false);
  const [decide, setDecide] = useState<{ txn: PaymentTxn; action: 'verify' | 'reject' } | null>(null);
  const [recording, setRecording] = useState(false);

  const awaiting = o.status === 'PENDING_PAYMENT';
  const awaitingAny = awaiting || o.status === 'PAYMENT_VERIFICATION';
  // Only online payments can be re-checked with a provider; transfers are checked by a person.
  const open = o.transactions.filter((t) => OPEN_TXN.includes(t.status) && t.provider !== 'BANK_TRANSFER');

  async function viewReceipt(t: PaymentTxn) {
    try {
      const r = await api<{ url: string }>(`/orders/${o.id}/transfers/${t.id}/receipt`);
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    }
  }

  async function createLink() {
    setBusy('link');
    setMsg(null);
    try {
      const r = await api<PaymentLink>(`/orders/${o.id}/payment-link`, { method: 'POST', body: email.trim() ? { email: email.trim() } : {} });
      setLink(r);
      setAskEmail(false);
      await onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'EMAIL_REQUIRED') setAskEmail(true);
      setMsg({ tone: 'bad', text: e instanceof ApiError && e.code === 'PAYMENTS_NOT_SET_UP' ? 'Connect a payment provider in Settings → Payments to take online payments.' : errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function checkNow() {
    setBusy('check');
    setMsg(null);
    try {
      await api(`/orders/${o.id}/payments/verify`, { method: 'POST', body: {} });
      await onChanged();
      setMsg({ tone: 'info', text: 'Checked with the payment provider.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setMsg({ tone: 'bad', text: 'Copy failed — select the link and copy it.' }); }
  }

  const waText = link ? `Hello ${o.customer?.fullName ?? ''}, here is the payment link for order ${o.reference} (${formatMoney(link.amountMinor, link.currency)}): ${link.checkoutUrl}` : '';

  return (
    <Card>
      <CardHeader title="Payments" description="Orders are marked paid only when the payment provider confirms the payment to our server."
        action={open.length > 0 && <Button size="sm" variant="secondary" loading={busy === 'check'} onClick={() => void checkNow()}>Check payment</Button>} />
      <div className="space-y-4 p-5">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

        {awaiting && can('orders:create') && (
          <div className="rounded-lg border border-line p-4">
            {!link ? (
              <div className="space-y-3">
                <p className="text-sm text-ink-2">Send the customer a payment link for {formatMoney(o.totalMinor, o.currency)} (card, bank transfer or USSD), through your default provider in Settings → Payments.</p>
                {(askEmail || !o.customer?.email) && (
                  <Field label="Customer email (for the payment receipt)">{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="customer@example.com" />}</Field>
                )}
                <Button size="sm" loading={busy === 'link'} disabled={!o.customer?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())} onClick={() => void createLink()}>Create payment link</Button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">{PROVIDER_NAME[link.provider] ?? 'Payment'} link {link.reused && <span className="font-normal text-ink-3">(the customer’s open link)</span>}</p>
                <p className="break-all rounded bg-sunken px-3 py-2 font-mono text-[12px]">{link.checkoutUrl}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void copy(link.checkoutUrl)}>{copied ? 'Copied' : 'Copy link'}</Button>
                  {o.customer?.phone && <a href={whatsappLink(o.customer.phone, waText)} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center rounded-[var(--radius-control)] bg-[#1f8b4c] px-3 text-sm font-semibold text-white">Send on WhatsApp</a>}
                </div>
              </div>
            )}
          </div>
        )}

        {awaitingAny && can('orders:create') && (
          <p className="text-[13px] text-ink-3">Customer paid by bank transfer? <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setRecording(true)}>Record the transfer</button> — then check your bank and verify it.</p>
        )}

        {o.transactions.length === 0 ? (
          <p className="text-sm text-ink-3">No payment attempts yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {o.transactions.map((t) => {
              const left = refundable(t);
              return (
                <li key={t.id} className="space-y-2 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2"><Badge tone={txnLabel(t)[1]}>{txnLabel(t)[0]}</Badge><span className="font-mono text-[12px] text-ink-3">{t.reference}</span><span className="text-[12px] text-ink-3">{PROVIDER_NAME[t.provider] ?? t.provider}</span></span>
                    <span className="font-semibold tabular">{formatMoney(t.grossMinor, t.currency)}</span>
                  </div>
                  {t.status === 'SUCCEEDED' && (
                    <dl className="grid grid-cols-3 gap-2 text-[13px]">
                      <div><dt className="text-ink-3">{PROVIDER_NAME[t.provider] ?? 'Provider'} fee</dt><dd className="tabular">{t.providerFeeMinor ? formatMoney(t.providerFeeMinor, t.currency) : '—'}</dd></div>
                      <div><dt className="text-ink-3">LiveSell commission</dt><dd className="tabular">{formatMoney(t.platformCommissionMinor, t.currency)}</dd></div>
                      <div><dt className="text-ink-3">You receive</dt><dd className="tabular">{t.sellerProceedsMinor ? formatMoney(t.sellerProceedsMinor, t.currency) : '—'}</dd></div>
                    </dl>
                  )}
                  {t.provider === 'BANK_TRANSFER' && t.transferEvidence && (
                    <div className="space-y-1 rounded-md bg-sunken p-3 text-[13px]">
                      <p><span className="text-ink-3">From</span> {t.transferEvidence.payerName}{t.transferEvidence.payerBank ? ` · ${t.transferEvidence.payerBank}` : ''}{t.transferEvidence.payerReference ? <> · ref <span className="font-mono">{t.transferEvidence.payerReference}</span></> : null}</p>
                      <p className="text-ink-3">Reported by {t.transferEvidence.submittedBy === 'customer' ? 'the customer' : 'your team'}{t.transferEvidence.amountClaimedMinor ? ` · says ${formatMoney(t.transferEvidence.amountClaimedMinor, t.currency)} was sent` : ''}</p>
                      {t.transferEvidence.decision && <p className="text-ink-3">{t.transferEvidence.decision.outcome === 'VERIFIED' ? 'Verified' : 'Not found'}{t.transferEvidence.decision.reason ? ` — ${t.transferEvidence.decision.reason}` : ''}</p>}
                      {t.status === 'PENDING' && <p className="text-warn">Not verified. Check your bank account before verifying — a receipt alone is not proof of payment.</p>}
                      <div className="flex flex-wrap gap-2 pt-1">
                        {t.transferEvidence.receiptKey && can('payments:read') && <Button size="sm" variant="ghost" onClick={() => void viewReceipt(t)}>View receipt</Button>}
                        {t.status === 'PENDING' && can('payments:verify_transfer') && <>
                          <Button size="sm" onClick={() => setDecide({ txn: t, action: 'verify' })}>Money received</Button>
                          <Button size="sm" variant="secondary" onClick={() => setDecide({ txn: t, action: 'reject' })}>Not in my account</Button>
                        </>}
                      </div>
                    </div>
                  )}
                  {t.status === 'SUCCEEDED' && t.failureReason && ATTENTION[t.failureReason] && <Alert tone="warn">{ATTENTION[t.failureReason]}</Alert>}
                  {t.status === 'FAILED' && t.failureReason && t.provider !== 'BANK_TRANSFER' && <p className="text-[13px] text-bad">{FAIL_REASON[t.failureReason] ?? t.failureReason}</p>}
                  {t.refunds.length > 0 && (
                    <ul className="space-y-1 text-[13px]">
                      {t.refunds.map((r) => <li key={r.id} className="flex justify-between gap-2"><span>Refund{r.reason ? ` — ${r.reason}` : ''} <Badge tone={REFUND_STATUS[r.status][1]}>{REFUND_STATUS[r.status][0]}</Badge></span><span className="tabular">− {formatMoney(r.amountMinor, r.currency)}</span></li>)}
                    </ul>
                  )}
                  {left > 0n && can('payments:refund') && <Button size="sm" variant="secondary" onClick={() => setRefundFor(t)}>Refund…</Button>}
                </li>
              );
            })}
          </ul>
        )}
        {can('payments:configure') && <p className="text-[13px] text-ink-3"><Link href="/settings/payments" className="hover:text-ink">Payment settings →</Link></p>}
      </div>
      {decide && <DecideDialog orderId={o.id} txn={decide.txn} action={decide.action} onClose={() => setDecide(null)} onDone={async (text) => { setDecide(null); setMsg({ tone: 'good', text }); await onChanged(); }} />}
      {recording && <RecordTransferDialog orderId={o.id} total={formatMoney(o.totalMinor, o.currency)} onClose={() => setRecording(false)} onDone={async () => { setRecording(false); setMsg({ tone: 'good', text: 'Transfer recorded. Check your bank account, then verify it.' }); await onChanged(); }} />}
      {refundFor && <RefundDialog orderId={o.id} txn={refundFor} max={refundable(refundFor)} onClose={() => setRefundFor(null)} onDone={async (text) => { setRefundFor(null); setMsg({ tone: 'good', text }); await onChanged(); }} />}
    </Card>
  );
}

function RefundDialog({ orderId, txn, max, onClose, onDone }: { orderId: string; txn: PaymentTxn; max: bigint; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [amount, setAmount] = useState(koboToNairaInput(max.toString()));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per dialog: pressing the button twice (or a retry after a dropped connection) never refunds twice.
  const [key] = useState(() => `rf-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())}`);
  const kobo = nairaToKobo(amount);
  const name = PROVIDER_NAME[txn.provider] ?? 'the payment provider';
  const manual = txn.provider === 'BANK_TRANSFER';
  const valid = kobo !== null && toMinor(kobo) > 0n && toMinor(kobo) <= max && (!manual || reason.trim().length >= 3);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api(`/orders/${orderId}/refunds`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { amountMinor: kobo, transactionId: txn.id, ...(reason.trim() ? { reason: reason.trim() } : {}) } });
      await onDone(manual ? `Refund of ${formatMoney(kobo!, txn.currency)} recorded.` : `Refund of ${formatMoney(kobo!, txn.currency)} sent to ${name}. The order updates once ${name} completes it.`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Refund payment" description={manual ? `Send the money back from your bank first, then record it here (up to ${formatMoney(max.toString(), txn.currency)}).` : `Up to ${formatMoney(max.toString(), txn.currency)} can be refunded on this payment. ${name}'s fee is not returned.${txn.provider === 'BACHS' ? ' Bachs allows only one refund per payment, so refund the full amount you intend now.' : ''}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={!valid} onClick={() => void submit()}>{manual ? 'Record refund' : 'Refund'} {valid ? formatMoney(kobo!, txn.currency) : ''}</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="bad">{error}</Alert>}
        <Field label="Amount (₦)" error={amount && !valid ? `Enter an amount up to ${formatMoney(max.toString(), txn.currency)}` : null}>{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label={manual ? 'How you refunded' : 'Reason (optional)'} hint={manual ? 'e.g. "Transfer from GTBank, ref 000123" — shown in the order activity' : 'Shown in the order activity'}>{(p) => <Input {...p} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

function DecideDialog({ orderId, txn, action, onClose, onDone }: { orderId: string; txn: PaymentTxn; action: 'verify' | 'reject'; onClose: () => void; onDone: (msg: string) => Promise<void> }) {
  const [amount, setAmount] = useState(koboToNairaInput(txn.grossMinor));
  const [text, setText] = useState('');
  const [seen, setSeen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kobo = nairaToKobo(amount);
  const valid = action === 'verify' ? kobo !== null && seen : text.trim().length >= 3;
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (action === 'verify') await api(`/orders/${orderId}/transfers/${txn.id}/verify`, { method: 'POST', body: { amountReceivedMinor: kobo, ...(text.trim() ? { note: text.trim() } : {}) } });
      else await api(`/orders/${orderId}/transfers/${txn.id}/reject`, { method: 'POST', body: { reason: text.trim() } });
      await onDone(action === 'verify' ? 'Transfer verified. The order is paid.' : 'Marked as not received. The order is waiting for payment again.');
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title={action === 'verify' ? 'Confirm the money arrived' : 'Transfer not in your account'}
      description={action === 'verify' ? `Open your bank app and find ${formatMoney(txn.grossMinor, txn.currency)} from ${txn.transferEvidence?.payerName ?? 'the customer'}.` : 'The customer sees that the transfer was not found and can report it again.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={action === 'verify' ? 'primary' : 'danger'} loading={busy} disabled={!valid} onClick={() => void submit()}>{action === 'verify' ? 'Verify payment' : 'Not received'}</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="bad">{error}</Alert>}
        {action === 'verify' ? <>
          <Field label="Amount you received (₦)" hint="Must match the order total">{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Note (optional)">{(p) => <Input {...p} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Seen in GTBank app" />}</Field>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={seen} onChange={(e) => setSeen(e.target.checked)} /> I have seen this money in my bank account (not only a receipt).</label>
        </> : (
          <Field label="What did you find?">{(p) => <Input {...p} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. No matching credit in our account" />}</Field>
        )}
      </div>
    </Dialog>
  );
}

function RecordTransferDialog({ orderId, total, onClose, onDone }: { orderId: string; total: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({ payerName: '', payerBank: '', payerReference: '' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const receiptKey = file ? await uploadFile(`/orders/${orderId}/transfers/receipt-url`, file, ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'], 5 * 1024 * 1024) : undefined;
      await api(`/orders/${orderId}/transfers`, { method: 'POST', body: { payerName: f.payerName.trim(), ...(f.payerBank.trim() ? { payerBank: f.payerBank.trim() } : {}), ...(f.payerReference.trim() ? { payerReference: f.payerReference.trim() } : {}), ...(receiptKey ? { receiptKey } : {}) } });
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Record a bank transfer" description={`For transfers the customer told you about (e.g. on WhatsApp). The order total is ${total}. It stays unpaid until someone verifies it.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={f.payerName.trim().length < 2} onClick={() => void submit()}>Record transfer</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="bad">{error}</Alert>}
        <Field label="Name on the paying account">{(p) => <Input {...p} maxLength={120} value={f.payerName} onChange={(e) => setF({ ...f, payerName: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Their bank (optional)">{(p) => <Input {...p} maxLength={80} value={f.payerBank} onChange={(e) => setF({ ...f, payerBank: e.target.value })} />}</Field>
          <Field label="Reference (optional)">{(p) => <Input {...p} maxLength={80} value={f.payerReference} onChange={(e) => setF({ ...f, payerReference: e.target.value })} />}</Field>
        </div>
        <Field label="Receipt (optional)" hint="Photo or PDF, up to 5 MB">{(p) => <input {...p} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm" />}</Field>
      </div>
    </Dialog>
  );
}
