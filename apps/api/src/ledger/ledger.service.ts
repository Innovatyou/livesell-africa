import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LedgerAccountType, Prisma } from '../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Chart of accounts. Tenant accounts belong to one seller; platform accounts (tenantId null) are LiveSell's own.
 * Seller books and platform books are separate journals, each balanced on its own.
 */
export const ACCOUNTS = {
  // Seller (tenant) accounts
  SALES_REVENUE: 'REVENUE',
  SALES_REFUNDS: 'EXPENSE', // contra-revenue
  GATEWAY_CLEARING: 'ASSET', // money held by the gateway, owed to the seller until it settles
  SELLER_BANK: 'ASSET', // direct bank transfers, already in the seller's own bank account
  PAYMENT_FEES: 'EXPENSE',
  COMMISSION_EXPENSE: 'EXPENSE',
  COMMISSION_PAYABLE: 'LIABILITY', // direct settlement: commission the seller owes LiveSell
  // Platform accounts
  SUBSCRIPTION_REVENUE: 'REVENUE',
  COMMISSION_REVENUE: 'REVENUE',
  COMMISSION_RECEIVABLE: 'ASSET',
  PLATFORM_GATEWAY_CLEARING: 'ASSET',
  PLATFORM_PAYMENT_FEES: 'EXPENSE',
} as const satisfies Record<string, LedgerAccountType>;

export type AccountCode = keyof typeof ACCOUNTS;

/** A signed line: positive = debit, negative = credit. Zero lines are dropped. */
export interface SignedLine { account: AccountCode; amountMinor: bigint; description?: string }

export class UnbalancedJournalError extends Error {}

/** Pure: turns signed lines into debit/credit rows and refuses anything that doesn't balance. */
export function toEntries(lines: SignedLine[]) {
  const entries = lines
    .filter((l) => l.amountMinor !== 0n)
    .map((l) => ({ account: l.account, direction: l.amountMinor > 0n ? ('DEBIT' as const) : ('CREDIT' as const), amountMinor: l.amountMinor < 0n ? -l.amountMinor : l.amountMinor, description: l.description }));
  const net = lines.reduce((s, l) => s + l.amountMinor, 0n);
  if (net !== 0n) throw new UnbalancedJournalError(`Journal is unbalanced by ${net} minor units`);
  if (entries.length < 2) throw new UnbalancedJournalError('A journal needs at least two lines');
  return entries;
}

/**
 * Double-entry ledger. Every money movement posts journals in the SAME database transaction as the business change
 * (rule 4). A deferred DB trigger rejects unbalanced journals at commit and another makes entries append-only.
 * Account rows are created on first use with raw SQL so platform accounts (tenant_id NULL) work inside
 * tenant-scoped transactions too.
 */
@Injectable()
export class LedgerService {
  async post(tx: Tx, journal: { tenantId: string | null; currency: string; transactionId?: string | null; lines: SignedLine[] }) {
    const entries = toEntries(journal.lines);
    const journalId = randomUUID();
    const ids = new Map<AccountCode, string>();
    for (const e of entries) if (!ids.has(e.account)) ids.set(e.account, await this.accountId(tx, journal.tenantId, e.account, journal.currency));
    await tx.ledgerEntry.createMany({
      data: entries.map((e) => ({
        journalId, accountId: ids.get(e.account)!, transactionId: journal.transactionId ?? null, direction: e.direction,
        amountMinor: e.amountMinor, currency: journal.currency, description: e.description ?? null,
      })),
    });
    return journalId;
  }

  private async accountId(tx: Tx, tenantId: string | null, code: AccountCode, currency: string) {
    const type = ACCOUNTS[code];
    await tx.$executeRaw`INSERT INTO ledger_accounts (id, tenant_id, code, type, currency)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${code}, ${type}::"LedgerAccountType", ${currency}) ON CONFLICT DO NOTHING`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM ledger_accounts
      WHERE tenant_id IS NOT DISTINCT FROM ${tenantId}::uuid AND code = ${code} AND currency = ${currency}`;
    if (!rows[0]) throw new Error(`Ledger account ${code} could not be created`);
    return rows[0].id;
  }
}

// ───────────────────────── Journal recipes (pure, unit-tested) ─────────────────────────

export type JournalMode = 'DIRECT' | 'SPLIT' | 'BANK_TRANSFER';
export interface SaleAmounts { grossMinor: bigint; feeMinor: bigint; commissionMinor: bigint; mode: JournalMode }

/** Verified order payment. Seller and platform journals. */
export function saleJournals(a: SaleAmounts): { seller: SignedLine[]; platform: SignedLine[] | null } {
  const { grossMinor: g, feeMinor: f, commissionMinor: c } = a;
  if (a.mode === 'SPLIT') {
    // Paid into the platform's Paystack account; the subaccount (seller) receives g − c − f, LiveSell keeps c.
    return {
      seller: [
        { account: 'GATEWAY_CLEARING', amountMinor: g - c - f, description: 'Payment received (split settlement)' },
        { account: 'PAYMENT_FEES', amountMinor: f, description: 'Gateway fee' },
        { account: 'COMMISSION_EXPENSE', amountMinor: c, description: 'LiveSell commission' },
        { account: 'SALES_REVENUE', amountMinor: -g, description: 'Sale' },
      ],
      platform: c > 0n ? [
        { account: 'PLATFORM_GATEWAY_CLEARING', amountMinor: c, description: 'Commission collected via split' },
        { account: 'COMMISSION_REVENUE', amountMinor: -c, description: 'Commission' },
      ] : null,
    };
  }
  // DIRECT: paid into the seller's own gateway account (BANK_TRANSFER: straight into their bank); commission is owed by
  // the seller.
  const cash = a.mode === 'BANK_TRANSFER' ? 'SELLER_BANK' : 'GATEWAY_CLEARING';
  return {
    seller: [
      { account: cash, amountMinor: g - f, description: a.mode === 'BANK_TRANSFER' ? 'Bank transfer received (verified)' : 'Payment received' },
      { account: 'PAYMENT_FEES', amountMinor: f, description: 'Gateway fee' },
      { account: 'SALES_REVENUE', amountMinor: -g, description: 'Sale' },
      { account: 'COMMISSION_EXPENSE', amountMinor: c, description: 'LiveSell commission' },
      { account: 'COMMISSION_PAYABLE', amountMinor: -c, description: 'Commission owed to LiveSell' },
    ],
    platform: c > 0n ? [
      { account: 'COMMISSION_RECEIVABLE', amountMinor: c, description: 'Commission due from seller' },
      { account: 'COMMISSION_REVENUE', amountMinor: -c, description: 'Commission' },
    ] : null,
  };
}

/** Commission reversed in proportion to the refunded share, rounded down (never reverse more than was charged). */
export function commissionReversal(commissionMinor: bigint, grossMinor: bigint, refundMinor: bigint, alreadyReversedMinor: bigint, fullyRefunded: boolean) {
  if (commissionMinor <= 0n || grossMinor <= 0n) return 0n;
  // The last refund sweeps any rounding remainder so a full refund reverses exactly the commission charged.
  if (fullyRefunded) return commissionMinor - alreadyReversedMinor;
  return (commissionMinor * refundMinor) / grossMinor;
}

/** Completed refund of `r`, with `cr` commission reversed. */
export function refundJournals(r: bigint, cr: bigint, mode: JournalMode): { seller: SignedLine[]; platform: SignedLine[] | null } {
  const seller: SignedLine[] = [
    { account: 'SALES_REFUNDS', amountMinor: r, description: 'Refund to customer' },
    { account: mode === 'BANK_TRANSFER' ? 'SELLER_BANK' : 'GATEWAY_CLEARING', amountMinor: -r, description: mode === 'BANK_TRANSFER' ? 'Refund sent by bank transfer' : 'Refund paid out' },
  ];
  if (cr <= 0n) return { seller, platform: null };
  if (mode === 'SPLIT') {
    seller.push({ account: 'GATEWAY_CLEARING', amountMinor: cr, description: 'Commission returned' }, { account: 'COMMISSION_EXPENSE', amountMinor: -cr, description: 'Commission reversed' });
    return { seller, platform: [{ account: 'COMMISSION_REVENUE', amountMinor: cr, description: 'Commission reversed' }, { account: 'PLATFORM_GATEWAY_CLEARING', amountMinor: -cr, description: 'Commission returned' }] };
  }
  seller.push({ account: 'COMMISSION_PAYABLE', amountMinor: cr, description: 'Commission reversed' }, { account: 'COMMISSION_EXPENSE', amountMinor: -cr, description: 'Commission reversed' });
  return { seller, platform: [{ account: 'COMMISSION_REVENUE', amountMinor: cr, description: 'Commission reversed' }, { account: 'COMMISSION_RECEIVABLE', amountMinor: -cr, description: 'Commission reversed' }] };
}

/** A commission invoice paid through the platform account: receivable → cash; the seller's payable is cleared. */
export function commissionSettlementJournals(g: bigint, f: bigint): { seller: SignedLine[]; platform: SignedLine[] } {
  return {
    seller: [
      { account: 'COMMISSION_PAYABLE', amountMinor: g, description: 'Commission paid to LiveSell' },
      { account: 'SELLER_BANK', amountMinor: -g, description: 'Commission invoice paid' },
    ],
    platform: [
      { account: 'PLATFORM_GATEWAY_CLEARING', amountMinor: g - f, description: 'Commission invoice payment received' },
      { account: 'PLATFORM_PAYMENT_FEES', amountMinor: f, description: 'Gateway fee' },
      { account: 'COMMISSION_RECEIVABLE', amountMinor: -g, description: 'Commission collected' },
    ],
  };
}

/** LiveSell subscription paid through the platform account. */
export function subscriptionJournal(g: bigint, f: bigint): SignedLine[] {
  return [
    { account: 'PLATFORM_GATEWAY_CLEARING', amountMinor: g - f, description: 'Subscription payment received' },
    { account: 'PLATFORM_PAYMENT_FEES', amountMinor: f, description: 'Gateway fee' },
    { account: 'SUBSCRIPTION_REVENUE', amountMinor: -g, description: 'Subscription' },
  ];
}
