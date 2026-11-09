import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { commissionFor, CommissionService } from '../billing/commission.service';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { Prisma } from '../generated/prisma/client';
import { LedgerService, saleJournals } from '../ledger/ledger.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ATTENTION, PaymentsService } from './payments.service';

type Tx = Prisma.TransactionClient;
const MAX_TRANSFER_ACCOUNTS = 3;
const MAX_PENDING_CLAIMS = 3;
const DEFAULT_TRANSFER_HOLD_HOURS = 72;

export interface TransferEvidence {
  payerName: string;
  payerBank?: string | null;
  payerReference?: string | null;
  amountClaimedMinor?: string | null;
  receiptKey?: string | null;
  bankAccountId?: string | null;
  submittedBy: 'customer' | 'staff';
  submittedByUserId?: string | null;
  submittedAt: string;
  decision?: { by: string; at: string; outcome: 'VERIFIED' | 'REJECTED'; reason?: string | null; amountReceivedMinor?: string | null };
}

export interface ClaimInput { payerName: string; payerBank?: string; payerReference?: string; amountMinor?: string; receiptKey?: string; bankAccountId?: string }

/**
 * Direct bank transfer (MASTER-SPEC §13). The customer pays into the seller's own bank account, reports it (with an
 * optional receipt), and an authorised person — `payments:verify_transfer` — checks their bank and verifies it.
 * A report or screenshot never marks anything paid (rule 4): only `verify()`, which records the transaction, posts
 * the ledger journal and calls `OrdersService.markPaidTx` in one database transaction. Unverified transfers are always
 * labelled as such and surface in reconciliation (§26 #5).
 */
@Injectable()
export class BankTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly ledger: LedgerService,
    private readonly orders: OrdersService,
    private readonly commission: CommissionService,
    private readonly payments: PaymentsService,
  ) {}

  // ───────────────────────── Seller's transfer accounts ─────────────────────────

  async listAccounts(tenantId: string) {
    const rows = await this.prisma.forTenant(tenantId).bankAccount.findMany({ where: { forTransfers: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    return rows.map((a) => this.view(a, tenantId));
  }

  async createAccount(tenantId: string, actorId: string, dto: { bankCode?: string; bankName: string; accountNumber: string; accountName: string; transferInstructions?: string; isDefault?: boolean }, ip?: string) {
    const db = this.prisma.forTenant(tenantId);
    if ((await db.bankAccount.count({ where: { forTransfers: true, isActive: true } })) >= MAX_TRANSFER_ACCOUNTS) {
      throw new ConflictException({ code: 'TOO_MANY_ACCOUNTS', message: `You can show up to ${MAX_TRANSFER_ACCOUNTS} bank accounts to customers.` });
    }
    // Confirm the name with the bank when a provider can (Paystack / Flutterwave account resolution).
    const resolved = dto.bankCode ? await this.payments.resolveBankAccount(dto.bankCode, dto.accountNumber) : null;
    const isFirst = (await db.bankAccount.count({ where: { forTransfers: true, isActive: true, isDefault: true } })) === 0;
    const makeDefault = isFirst || !!dto.isDefault;
    const row = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      if (makeDefault) await tx.bankAccount.updateMany({ where: { forTransfers: true, isDefault: true }, data: { isDefault: false } });
      return tx.bankAccount.create({
        data: {
          bankName: dto.bankName, bankCode: dto.bankCode ?? null, accountName: resolved?.accountName ?? dto.accountName,
          accountNumberEnc: this.crypto.encrypt(dto.accountNumber, tenantId), accountNumberLast4: dto.accountNumber.slice(-4),
          transferInstructions: dto.transferInstructions ?? null, currencies: ['NGN'], forTransfers: true, isActive: true, isDefault: makeDefault,
          nameVerified: !!resolved,
        } as Prisma.BankAccountUncheckedCreateInput,
      });
    });
    await this.audit.record({ action: 'payments.transfer_account_added', actorId, tenantId, entityType: 'bank_account', entityId: row.id, ip, metadata: { bank: dto.bankName, last4: row.accountNumberLast4, nameVerified: !!resolved } });
    return { ...this.view(row, tenantId), nameMismatch: resolved ? normalise(resolved.accountName) !== normalise(dto.accountName) : false };
  }

  async updateAccount(tenantId: string, actorId: string, id: string, dto: { transferInstructions?: string | null; isActive?: boolean; isDefault?: boolean }) {
    const row = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const a = await tx.bankAccount.findFirst({ where: { id, forTransfers: true } });
      if (!a) throw new NotFoundException('Bank account not found');
      if (dto.isDefault) await tx.bankAccount.updateMany({ where: { forTransfers: true, isDefault: true, id: { not: id } }, data: { isDefault: false } });
      return tx.bankAccount.update({
        where: { id },
        data: {
          ...(dto.transferInstructions !== undefined ? { transferInstructions: dto.transferInstructions } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive, ...(dto.isActive ? {} : { isDefault: false }) } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault && (dto.isActive ?? a.isActive) } : {}),
        },
      });
    });
    await this.audit.record({ action: 'payments.transfer_account_updated', actorId, tenantId, entityType: 'bank_account', entityId: id, metadata: { isActive: row.isActive, isDefault: row.isDefault } });
    return this.view(row, tenantId);
  }

  async removeAccount(tenantId: string, actorId: string, id: string) {
    const db = this.prisma.forTenant(tenantId);
    const a = await db.bankAccount.findFirst({ where: { id, forTransfers: true } });
    if (!a) throw new NotFoundException('Bank account not found');
    await db.bankAccount.delete({ where: { id } });
    await this.audit.record({ action: 'payments.transfer_account_removed', actorId, tenantId, entityType: 'bank_account', entityId: id, metadata: { last4: a.accountNumberLast4 } });
    return { removed: true };
  }

  /** What customers see: the store's active transfer accounts (shown in full: that is their purpose). */
  async publicAccounts(tenantId: string) {
    const rows = await this.prisma.forTenant(tenantId).bankAccount.findMany({ where: { forTransfers: true, isActive: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
    return rows.map((a) => ({ id: a.id, bankName: a.bankName, accountName: a.accountName, accountNumber: this.crypto.decrypt(a.accountNumberEnc, tenantId), instructions: a.transferInstructions, nameVerified: a.nameVerified }));
  }

  // ───────────────────────── Reporting a transfer ─────────────────────────

  presignReceipt(tenantId: string, contentType: string, contentLength: number) {
    return this.storage.presignUpload(tenantId, 'transfer-receipt', contentType, contentLength);
  }

  /** Storefront: the customer reports their transfer. The private tracking token proves who they are. */
  async customerClaim(tenantId: string, orderReference: string, token: string, dto: ClaimInput) {
    const order = await this.orderByToken(tenantId, orderReference, token);
    return this.claim(tenantId, order.id, dto, { actorId: null, via: 'customer' });
  }

  async customerReceiptUrl(tenantId: string, orderReference: string, token: string, contentType: string, contentLength: number) {
    await this.orderByToken(tenantId, orderReference, token);
    return this.presignReceipt(tenantId, contentType, contentLength);
  }

  /** Records a reported transfer as an unverified bank-transfer transaction and moves the order to verification. */
  async claim(tenantId: string, orderId: string, dto: ClaimInput, by: { actorId: string | null; via: 'customer' | 'staff' }) {
    const db = this.prisma.forTenant(tenantId);
    if ((await db.bankAccount.count({ where: { forTransfers: true, isActive: true } })) === 0) {
      throw new ConflictException({ code: 'TRANSFERS_NOT_SET_UP', message: 'This store has not added a bank account for transfers.' });
    }
    if (dto.bankAccountId && !(await db.bankAccount.findFirst({ where: { id: dto.bankAccountId, forTransfers: true }, select: { id: true } }))) {
      throw new BadRequestException('Unknown bank account');
    }
    const receipt = dto.receiptKey ? await this.storage.confirmUpload(tenantId, 'transfer-receipt', dto.receiptKey) : null;
    const holdUntil = new Date(Date.now() + (await this.holdHours()) * 3_600_000);
    const rate = await this.commission.effectiveRate(tenantId, 'BANK_TRANSFER');

    const txn = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new NotFoundException('Order not found');
      const pending = await tx.paymentTransaction.count({ where: { orderId, provider: 'BANK_TRANSFER', status: 'PENDING' } });
      if (pending >= MAX_PENDING_CLAIMS) throw new ConflictException({ code: 'TOO_MANY_CLAIMS', message: 'This order already has transfers waiting for the seller to check.' });
      const evidence: TransferEvidence = {
        payerName: dto.payerName, payerBank: dto.payerBank ?? null, payerReference: dto.payerReference ?? null,
        amountClaimedMinor: dto.amountMinor ?? null, receiptKey: receipt?.key ?? null, bankAccountId: dto.bankAccountId ?? null,
        submittedBy: by.via, submittedByUserId: by.actorId, submittedAt: new Date().toISOString(),
      };
      const reference = `${order.reference}-T${randomBytes(4).toString('hex').toUpperCase()}`;
      const t = await tx.paymentTransaction.create({
        data: {
          purpose: 'ORDER', orderId, customerId: order.customerId, provider: 'BANK_TRANSFER', reference, idempotencyKey: `transfer:${reference}`,
          currency: order.currency, grossMinor: order.totalMinor, platformCommissionMinor: commissionFor(order.totalMinor, rate?.bps ?? 0),
          settlementMode: 'BANK_TRANSFER', status: 'PENDING', transferEvidence: evidence as unknown as Prisma.InputJsonValue,
        } as Prisma.PaymentTransactionUncheckedCreateInput,
      });
      await this.orders.awaitVerificationTx(tx, tenantId, orderId, {
        holdUntil, actorId: by.actorId, actorType: by.via === 'customer' ? 'customer' : 'user',
        note: `${by.via === 'customer' ? 'Customer' : 'Staff'} reported a bank transfer from ${dto.payerName}${dto.payerReference ? ` (ref ${dto.payerReference})` : ''}. Not verified yet.`,
      });
      return t;
    });
    await this.audit.record({
      action: 'payment.transfer_reported', actorId: by.actorId, tenantId, entityType: 'order', entityId: orderId,
      metadata: { reference: txn.reference, via: by.via, amountClaimedMinor: dto.amountMinor ?? null, receipt: !!receipt },
    });
    return this.claimView(txn);
  }

  // ───────────────────────── Verifying ─────────────────────────

  /**
   * An authorised person confirms the money is in the store's bank account. The amount they saw must equal what the
   * order asked for; anything else is rejected so the customer can be asked to correct it.
   */
  async verify(tenantId: string, actorId: string, orderId: string, txnId: string, dto: { amountReceivedMinor: string; note?: string }, ip?: string) {
    const received = BigInt(dto.amountReceivedMinor);
    const outcome = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const t = await this.lockClaim(tx, tenantId, orderId, txnId);
      if (t.status !== 'PENDING') throw new ConflictException({ code: 'ALREADY_DECIDED', message: t.status === 'SUCCEEDED' ? 'This transfer is already verified.' : 'This transfer was rejected.' });
      if (received !== t.grossMinor) {
        throw new BadRequestException({ code: 'AMOUNT_MISMATCH', message: `The order total is ${t.grossMinor} kobo. If a different amount arrived, reject this transfer and ask the customer to pay the difference or refund it.` });
      }
      const evidence = { ...(t.transferEvidence as unknown as TransferEvidence), decision: { by: actorId, at: new Date().toISOString(), outcome: 'VERIFIED' as const, reason: dto.note ?? null, amountReceivedMinor: received.toString() } };
      const j = saleJournals({ grossMinor: t.grossMinor, feeMinor: 0n, commissionMinor: t.platformCommissionMinor, mode: 'BANK_TRANSFER' });
      await this.ledger.post(tx, { tenantId, currency: t.currency, transactionId: t.id, lines: j.seller });
      if (j.platform) await this.ledger.post(tx, { tenantId: null, currency: t.currency, transactionId: t.id, lines: j.platform });
      const { payable, status } = await this.orders.isPayableTx(tx, tenantId, orderId);
      let attention: string | null = null;
      if (payable) {
        await this.orders.markPaidTx(tx, tenantId, orderId, { verifiedBy: 'bank transfer checked by staff', actorId });
      } else {
        attention = status === 'CANCELLED' ? ATTENTION.ORDER_CLOSED : ATTENTION.DUPLICATE;
        await this.orders.noteTx(tx, tenantId, orderId, `Bank transfer ${t.reference} was verified but the order was already ${status === 'CANCELLED' ? 'cancelled' : 'paid'}. Refund it from the order's payments.`, actorId);
      }
      return tx.paymentTransaction.update({
        where: { id: t.id },
        data: {
          status: 'SUCCEEDED', verifiedAt: new Date(), verifiedBy: `user:${actorId}`, providerFeeMinor: 0n, sellerProceedsMinor: t.grossMinor - t.platformCommissionMinor,
          settlementStatus: 'SETTLED', failureReason: attention, transferEvidence: evidence as unknown as Prisma.InputJsonValue,
        },
      });
    });
    await this.audit.record({
      action: outcome.failureReason ? 'payment.needs_refund' : 'payment.transfer_verified', actorId, tenantId, entityType: 'order', entityId: orderId, ip,
      metadata: { reference: outcome.reference, amountMinor: outcome.grossMinor.toString(), attention: outcome.failureReason },
    });
    return this.claimView(outcome);
  }

  async reject(tenantId: string, actorId: string, orderId: string, txnId: string, dto: { reason: string }, ip?: string) {
    const out = await this.prisma.tenantTransaction(tenantId, async (tx) => {
      const t = await this.lockClaim(tx, tenantId, orderId, txnId);
      if (t.status !== 'PENDING') throw new ConflictException({ code: 'ALREADY_DECIDED', message: 'This transfer was already checked.' });
      const evidence = { ...(t.transferEvidence as unknown as TransferEvidence), decision: { by: actorId, at: new Date().toISOString(), outcome: 'REJECTED' as const, reason: dto.reason } };
      const u = await tx.paymentTransaction.update({ where: { id: t.id }, data: { status: 'FAILED', failureReason: `Transfer not found: ${dto.reason}`.slice(0, 300), transferEvidence: evidence as unknown as Prisma.InputJsonValue } });
      const stillPending = await tx.paymentTransaction.count({ where: { orderId, provider: 'BANK_TRANSFER', status: 'PENDING' } });
      if (!stillPending) await this.orders.backToPendingTx(tx, tenantId, orderId, actorId, `Reported bank transfer ${t.reference} was not found: ${dto.reason}`);
      return u;
    });
    await this.audit.record({ action: 'payment.transfer_rejected', actorId, tenantId, entityType: 'order', entityId: orderId, ip, metadata: { reference: out.reference, reason: dto.reason } });
    return this.claimView(out);
  }

  async receiptUrl(tenantId: string, orderId: string, txnId: string) {
    const t = await this.prisma.forTenant(tenantId).paymentTransaction.findFirst({ where: { id: txnId, orderId, provider: 'BANK_TRANSFER' } });
    const key = (t?.transferEvidence as unknown as TransferEvidence | null)?.receiptKey;
    if (!t || !key) throw new NotFoundException('No receipt for this transfer');
    return { url: await this.storage.readUrl(key, 'transfer-receipt') };
  }

  /** Transfers waiting for someone to check the bank (oldest first): the "clearly identify unverified" list. */
  async pending(tenantId: string) {
    const rows = await this.prisma.forTenant(tenantId).paymentTransaction.findMany({
      where: { provider: 'BANK_TRANSFER', status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 200,
      include: { order: { select: { id: true, reference: true, status: true, reservationExpiresAt: true, customer: { select: { fullName: true } } } } },
    });
    return rows.map((t) => ({ ...this.claimView(t), order: t.order }));
  }

  /** For the tracking page: transfer details and the state of the customer's reports (no internal fields). */
  async trackingInfo(tenantId: string, orderId: string, awaiting: boolean) {
    const claims = await this.prisma.forTenant(tenantId).paymentTransaction.findMany({ where: { orderId, provider: 'BANK_TRANSFER' }, orderBy: { createdAt: 'asc' }, select: { status: true, createdAt: true, reference: true } });
    return {
      accounts: awaiting ? await this.publicAccounts(tenantId) : [],
      claims: claims.map((c) => ({ reference: c.reference, status: c.status === 'PENDING' ? 'AWAITING_CHECK' : c.status === 'SUCCEEDED' ? 'VERIFIED' : 'NOT_FOUND', reportedAt: c.createdAt })),
    };
  }

  // ───────────────────────── internals ─────────────────────────

  private async orderByToken(tenantId: string, orderReference: string, token: string) {
    if (!/^LS-[A-Z0-9]{6}$/i.test(orderReference) || !token || token.length > 100) throw new NotFoundException('Order not found');
    const order = await this.prisma.forTenant(tenantId).order.findFirst({ where: { reference: orderReference.toUpperCase(), trackingTokenHash: this.crypto.hashToken(token) }, select: { id: true } });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private async lockClaim(tx: Tx, tenantId: string, orderId: string, txnId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM payment_transactions WHERE id = ${txnId}::uuid AND tenant_id = ${tenantId}::uuid AND order_id = ${orderId}::uuid AND provider = 'BANK_TRANSFER' FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Transfer not found');
    return tx.paymentTransaction.findUniqueOrThrow({ where: { id: txnId } });
  }

  private claimView(t: { id: string; reference: string; status: string; grossMinor: bigint; currency: string; transferEvidence: unknown; verifiedAt: Date | null; verifiedBy: string | null; failureReason: string | null; createdAt: Date }) {
    const e = (t.transferEvidence ?? {}) as TransferEvidence;
    return {
      id: t.id, reference: t.reference, status: t.status, verified: t.status === 'SUCCEEDED', grossMinor: t.grossMinor, currency: t.currency,
      payerName: e.payerName, payerBank: e.payerBank ?? null, payerReference: e.payerReference ?? null, amountClaimedMinor: e.amountClaimedMinor ?? null,
      hasReceipt: !!e.receiptKey, submittedBy: e.submittedBy, decision: e.decision ?? null, attention: t.status === 'SUCCEEDED' ? t.failureReason : null,
      reason: t.status === 'FAILED' ? t.failureReason : null, verifiedAt: t.verifiedAt, createdAt: t.createdAt,
    };
  }

  private view(a: { id: string; bankName: string; bankCode: string | null; accountName: string; accountNumberEnc: string; accountNumberLast4: string; transferInstructions: string | null; isActive: boolean; isDefault: boolean; nameVerified: boolean; createdAt: Date }, tenantId: string) {
    return {
      id: a.id, bankName: a.bankName, bankCode: a.bankCode, accountName: a.accountName, accountNumber: this.crypto.decrypt(a.accountNumberEnc, tenantId), last4: a.accountNumberLast4,
      transferInstructions: a.transferInstructions, isActive: a.isActive, isDefault: a.isDefault, nameVerified: a.nameVerified, createdAt: a.createdAt,
    };
  }

  private async holdHours() {
    const s = await this.prisma.platformSetting.findUnique({ where: { key: 'orders.transfer_hold_hours' } });
    const v = Number(s?.value);
    return Number.isInteger(v) && v >= 1 && v <= 168 ? v : DEFAULT_TRANSFER_HOLD_HOURS;
  }
}

const normalise = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '');
