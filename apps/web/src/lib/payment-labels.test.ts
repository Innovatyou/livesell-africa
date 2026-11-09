import { describe, expect, it } from 'vitest';
import { PROVIDER_NAME, refundable, TXN_STATUS, txnLabel } from './payment-labels';
import type { PaymentTxn } from './types';

const txn = (over: Partial<PaymentTxn> = {}): PaymentTxn => ({
  id: 't', reference: 'LS-ABCDEF-1', provider: 'PAYSTACK', status: 'SUCCEEDED', grossMinor: '5000000', currency: 'NGN', providerFeeMinor: '1500',
  platformCommissionMinor: '0', sellerProceedsMinor: '4998500', settlementMode: 'DIRECT', failureReason: null, verifiedAt: null, createdAt: '', refunds: [], ...over,
});
const refund = (amountMinor: string, status: PaymentTxn['refunds'][number]['status']) => ({ id: amountMinor + status, amountMinor, currency: 'NGN', status, reason: null, createdAt: '' });

describe('payment labels', () => {
  it('only verified payments can be refunded; in-flight refunds count, failed ones do not', () => {
    expect(refundable(txn({ status: 'PENDING' }))).toBe(0n);
    expect(refundable(txn())).toBe(5_000_000n);
    expect(refundable(txn({ refunds: [refund('1000000', 'SUCCEEDED'), refund('500000', 'PROCESSING'), refund('3000000', 'FAILED')] }))).toBe(3_500_000n);
    expect(refundable(txn({ refunds: [refund('5000000', 'SUCCEEDED')] }))).toBe(0n);
  });
  it('labels every transaction status', () => {
    for (const s of ['INITIALIZED', 'PENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED', 'REVERSED'] as const) expect(TXN_STATUS[s][0]).toBeTruthy();
  });
  it('names every online provider', () => {
    expect(['PAYSTACK', 'FLUTTERWAVE', 'BACHS'].map((c) => PROVIDER_NAME[c])).toEqual(['Paystack', 'Flutterwave', 'Bachs']);
  });
  it('labels bank transfers by what the seller has to do', () => {
    expect(txnLabel({ provider: 'BANK_TRANSFER', status: 'PENDING' })).toEqual(['Transfer to check', 'warn']);
    expect(txnLabel({ provider: 'BANK_TRANSFER', status: 'SUCCEEDED' })[0]).toBe('Transfer verified');
    expect(txnLabel({ provider: 'BANK_TRANSFER', status: 'FAILED' })[0]).toBe('Transfer not found');
    expect(txnLabel({ provider: 'PAYSTACK', status: 'PENDING' })[0]).toBe('Waiting for customer');
  });
});
