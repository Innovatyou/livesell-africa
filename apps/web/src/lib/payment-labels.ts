import { toMinor } from './money';
import type { PaymentTxn, TxnStatus } from './types';

export const TXN_STATUS: Record<TxnStatus, [string, 'good' | 'warn' | 'bad' | 'neutral' | 'info']> = {
  INITIALIZED: ['Starting', 'neutral'], PENDING: ['Waiting for customer', 'info'], SUCCEEDED: ['Paid', 'good'],
  FAILED: ['Failed', 'bad'], ABANDONED: ['Not completed', 'neutral'], REVERSED: ['Reversed', 'bad'],
};
export const ATTENTION: Record<string, string> = {
  ORDER_NOT_PAYABLE: 'Paid after the order was cancelled. Refund the customer.',
  DUPLICATE_PAYMENT: 'Second payment for an order that was already paid. Refund the customer.',
  INVOICE_NOT_OPEN: 'Paid for an invoice that was already closed.',
};
export const FAIL_REASON: Record<string, string> = { PROVIDER_UNAVAILABLE: 'The payment provider was not responding', AMOUNT_MISMATCH: 'Amount paid did not match the order — not accepted' };
export const REFUND_STATUS = { REQUESTED: ['Requested', 'neutral'], PROCESSING: ['Processing', 'info'], SUCCEEDED: ['Refunded', 'good'], FAILED: ['Failed', 'bad'] } as const;
export const OPEN_TXN: TxnStatus[] = ['INITIALIZED', 'PENDING', 'ABANDONED'];

/** What can still be refunded on a payment: refunds in flight count; failed ones don't. */
export const refundable = (t: PaymentTxn) => t.status === 'SUCCEEDED'
  ? toMinor(t.grossMinor) - t.refunds.filter((r) => r.status !== 'FAILED').reduce((s, r) => s + toMinor(r.amountMinor), 0n)
  : 0n;


export const PROVIDER_NAME: Record<string, string> = { PAYSTACK: 'Paystack', FLUTTERWAVE: 'Flutterwave', BACHS: 'Bachs', BANK_TRANSFER: 'Bank transfer' };
export const RECON_LABEL: Record<string, string> = {
  SALE_NOT_IN_LEDGER: 'Payment missing from the books', REFUND_NOT_IN_LEDGER: 'Refund missing from the books', PAID_WITHOUT_PAYMENT: 'Paid order without a payment',
  NEEDS_REFUND: 'Money to refund', UNVERIFIED_TRANSFER: 'Transfer waiting to be checked', TRANSFER_ON_CLOSED_ORDER: 'Transfer on a cancelled order', REFUND_STUCK: 'Refund not completing',
};
/** Bank-transfer payments show "Transfer to check" instead of the online "Waiting for customer". */
export function txnLabel(t: { provider: string; status: TxnStatus }): [string, 'good' | 'warn' | 'bad' | 'neutral' | 'info'] {
  if (t.provider === 'BANK_TRANSFER') {
    if (t.status === 'PENDING') return ['Transfer to check', 'warn'];
    if (t.status === 'FAILED') return ['Transfer not found', 'bad'];
    if (t.status === 'SUCCEEDED') return ['Transfer verified', 'good'];
  }
  return TXN_STATUS[t.status];
}
