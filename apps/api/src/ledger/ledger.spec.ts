import { commissionReversal, refundJournals, saleJournals, SignedLine, subscriptionJournal, toEntries, UnbalancedJournalError } from './ledger.service';

const net = (lines: SignedLine[]) => lines.reduce((s, l) => s + l.amountMinor, 0n);
const sumOf = (lines: SignedLine[], account: string) => lines.filter((l) => l.account === account).reduce((s, l) => s + l.amountMinor, 0n);

describe('ledger journals', () => {
  it('refuses unbalanced or one-sided journals and drops zero lines', () => {
    expect(() => toEntries([{ account: 'SALES_REVENUE', amountMinor: -100n }, { account: 'GATEWAY_CLEARING', amountMinor: 99n }])).toThrow(UnbalancedJournalError);
    expect(() => toEntries([{ account: 'SALES_REVENUE', amountMinor: 0n }, { account: 'GATEWAY_CLEARING', amountMinor: 0n }])).toThrow(UnbalancedJournalError);
    const e = toEntries([{ account: 'GATEWAY_CLEARING', amountMinor: 100n }, { account: 'PAYMENT_FEES', amountMinor: 0n }, { account: 'SALES_REVENUE', amountMinor: -100n }]);
    expect(e).toEqual([
      { account: 'GATEWAY_CLEARING', direction: 'DEBIT', amountMinor: 100n, description: undefined },
      { account: 'SALES_REVENUE', direction: 'CREDIT', amountMinor: 100n, description: undefined },
    ]);
  });

  it.each(['DIRECT', 'SPLIT'] as const)('%s sale: both books balance; seller nets gross − fee − commission', (mode) => {
    const j = saleJournals({ grossMinor: 2_500_000n, feeMinor: 47_500n, commissionMinor: 75_000n, mode });
    expect(net(j.seller)).toBe(0n);
    expect(net(j.platform!)).toBe(0n);
    expect(sumOf(j.seller, 'SALES_REVENUE')).toBe(-2_500_000n);
    expect(sumOf(j.platform!, 'COMMISSION_REVENUE')).toBe(-75_000n);
    const sellerCash = sumOf(j.seller, 'GATEWAY_CLEARING') + sumOf(j.seller, 'COMMISSION_PAYABLE');
    expect(sellerCash).toBe(2_500_000n - 47_500n - 75_000n);
    expect(() => toEntries(j.seller)).not.toThrow();
  });

  it('no commission → no platform journal', () => {
    expect(saleJournals({ grossMinor: 100n, feeMinor: 0n, commissionMinor: 0n, mode: 'DIRECT' }).platform).toBeNull();
  });

  it('commission is reversed proportionally and exactly in full across partial refunds', () => {
    const c = 333n;
    const g = 10_000n;
    const parts = [3_333n, 3_333n, 3_334n];
    let reversed = 0n;
    let refunded = 0n;
    for (const p of parts) {
      refunded += p;
      reversed += commissionReversal(c, g, p, reversed, refunded >= g);
    }
    expect(reversed).toBe(c);
    expect(commissionReversal(c, g, 5_000n, 0n, false)).toBe(166n); // rounded down
    expect(commissionReversal(0n, g, 5_000n, 0n, true)).toBe(0n);
  });

  it.each(['DIRECT', 'SPLIT'] as const)('%s refund journals balance', (mode) => {
    const j = refundJournals(1_000n, 30n, mode);
    expect(net(j.seller)).toBe(0n);
    expect(net(j.platform!)).toBe(0n);
    expect(sumOf(j.seller, 'SALES_REFUNDS')).toBe(1_000n);
    expect(refundJournals(1_000n, 0n, mode).platform).toBeNull();
  });

  it('subscription payment balances on the platform books', () => {
    const j = subscriptionJournal(1_500_000n, 32_500n);
    expect(net(j)).toBe(0n);
    expect(sumOf(j, 'SUBSCRIPTION_REVENUE')).toBe(-1_500_000n);
  });

  it('bank transfer: the sale lands in the seller’s bank (no gateway, no fee); refunds leave from it', () => {
    const j = saleJournals({ grossMinor: 2_500_000n, feeMinor: 0n, commissionMinor: 75_000n, mode: 'BANK_TRANSFER' });
    expect(net(j.seller)).toBe(0n);
    expect(sumOf(j.seller, 'SELLER_BANK')).toBe(2_500_000n);
    expect(sumOf(j.seller, 'GATEWAY_CLEARING')).toBe(0n);
    expect(sumOf(j.seller, 'COMMISSION_PAYABLE')).toBe(-75_000n);
    expect(sumOf(j.platform!, 'COMMISSION_RECEIVABLE')).toBe(75_000n);
    const r = refundJournals(1_000_000n, 30_000n, 'BANK_TRANSFER');
    expect(net(r.seller)).toBe(0n);
    expect(sumOf(r.seller, 'SELLER_BANK')).toBe(-1_000_000n);
    expect(sumOf(r.seller, 'COMMISSION_PAYABLE')).toBe(30_000n);
  });
});
