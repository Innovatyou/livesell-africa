import { Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { DecimalAmountError, decimalToMinor, minorToDecimal } from './money-decimal';
import {
  InitializePaymentInput, PaymentProvider, ProviderCapabilities, ProviderCredentials, ProviderRequestError, ProviderUnavailableError, RefundInput,
  RefundStatus, VerifiedStatus, VerifyPaymentResult, WebhookEvent,
} from './payment-provider';

const BASE = 'https://api.flutterwave.com/v3';
const TIMEOUT_MS = 15_000;

interface Envelope<T> { status: 'success' | 'error'; message: string; data?: T }

/**
 * Flutterwave v3 adapter (Flutterwave Standard). Sources: developer.flutterwave.com docs pages
 * "Flutterwave Standard", "Transaction Verification", "Webhooks", "Refunds", "Split Payments" and the v3 API
 * reference (verify_by_reference, transaction refund, refunds, subaccounts, banks, accounts/resolve). Response
 * shapes confirmed against the test environment with the test keys.
 *
 * - Amounts are major units (naira) as JSON numbers; converted exactly via money-decimal.
 * - A duplicate tx_ref is NOT rejected at initialize (confirmed), so our references must be unique (they are random).
 * - verify_by_reference answers 400 "No transaction was found" until the customer attempts payment.
 * - Webhooks: the `verif-hash` header must equal the secret hash set on the dashboard (documented scheme).
 * - Split: subaccount + per-payment `transaction_charge_type: "flat"` = LiveSell's commission; the subaccount
 *   receives gross − commission − Flutterwave fee (worked example in "Overriding the Default").
 */
@Injectable()
export class FlutterwaveAdapter implements PaymentProvider {
  readonly code = 'FLUTTERWAVE' as const;
  readonly displayName = 'Flutterwave';
  readonly capabilities: ProviderCapabilities = { split: true, multipleRefunds: true, minRefundMinor: 10_000n, webhookSecret: 'separate', requiresPublicCallback: false };
  private readonly logger = new Logger(FlutterwaveAdapter.name);

  keyMode(secretKey: string) {
    const m = /^FLWSECK(_TEST)?-[A-Za-z0-9]{16,}-X$/.exec(secretKey.trim());
    return m ? (m[1] ? 'test' : 'live') : null;
  }

  async validateCredentials(creds: ProviderCredentials) {
    const r = await this.request<unknown>(creds, 'GET', '/transactions?page=1', undefined, { allow401: true });
    return { valid: r !== 'UNAUTHORIZED', testMode: this.keyMode(creds.secretKey) === 'test' };
  }

  async initializePayment(creds: ProviderCredentials, input: InitializePaymentInput) {
    const body: Record<string, unknown> = {
      tx_ref: input.reference, amount: minorToDecimal(input.amountMinor), currency: input.currency, redirect_url: input.callbackUrl,
      customer: { email: input.customerEmail, ...(input.customerName ? { name: input.customerName.slice(0, 100) } : {}) },
      meta: input.metadata, customizations: { title: 'LiveSell' }, session_duration: 1440,
    };
    if (input.split) {
      // No commission (e.g. free trial): the subaccount's default split (flat 0) applies, so no override is sent.
      body.subaccounts = [input.split.platformChargeMinor > 0n
        ? { id: input.split.subaccountCode, transaction_charge_type: 'flat', transaction_charge: minorToDecimal(input.split.platformChargeMinor) }
        : { id: input.split.subaccountCode }];
    }
    const d = await this.request<{ link: string }>(creds, 'POST', '/payments', body);
    if (d === 'UNAUTHORIZED' || !d?.link) throw new ProviderRequestError('Flutterwave did not return a payment link');
    return { checkoutUrl: d.link };
  }

  async verifyPayment(creds: ProviderCredentials, reference: string): Promise<VerifyPaymentResult> {
    let d: 'UNAUTHORIZED' | { id: number; tx_ref: string; status: string; amount: number; currency: string; app_fee: number | null; created_at: string | null; processor_response: string | null };
    try {
      d = await this.request(creds, 'GET', `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`);
    } catch (e) {
      if (e instanceof ProviderRequestError && /no transaction was found/i.test(e.message)) {
        return { status: 'NOT_FOUND', amountMinor: null, currency: null, providerReference: null, feeMinor: null, paidAt: null, message: e.message, testMode: null, raw: null };
      }
      throw e;
    }
    if (d === 'UNAUTHORIZED') throw new ProviderRequestError('Flutterwave rejected the API key');
    if (d.tx_ref !== reference) throw new ProviderRequestError('Flutterwave returned a different transaction');
    let amountMinor: bigint | null = null;
    try {
      amountMinor = d.amount == null ? null : decimalToMinor(d.amount);
    } catch (e) {
      if (!(e instanceof DecimalAmountError)) throw e; // sub-kobo amount: leave null so it can't match
    }
    return {
      status: mapFlwStatus(d.status), amountMinor, currency: d.currency ?? null, providerReference: d.id == null ? null : String(d.id),
      feeMinor: d.app_fee == null ? null : decimalToMinor(d.app_fee, { round: true }), paidAt: d.status === 'successful' && d.created_at ? new Date(d.created_at) : null,
      message: d.processor_response ?? null, testMode: this.keyMode(creds.secretKey) === 'test', raw: d,
    };
  }

  parseWebhook(creds: ProviderCredentials, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const secret = creds.webhookSecret;
    const sig = headers['verif-hash'];
    if (!secret || typeof sig !== 'string' || !safeEqual(sig, secret)) return null;
    let p: { event?: string; data?: { id?: number | string; tx_ref?: string; status?: string; flw_ref?: string } };
    try {
      p = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const event = String(p.event ?? 'unknown');
    const d = p.data ?? {};
    return { eventId: `${event}:${d.id ?? ''}:${d.status ?? ''}`, eventType: event, paymentReference: d.tx_ref };
  }

  async refundPayment(creds: ProviderCredentials, input: RefundInput) {
    if (!input.providerReference) throw new ProviderRequestError('This payment has no Flutterwave transaction id to refund');
    const d = await this.request<{ id: number; flw_ref?: string; status: string }>(creds, 'POST', `/transactions/${encodeURIComponent(input.providerReference)}/refund`, {
      amount: minorToDecimal(input.amountMinor), ...(input.note ? { comments: input.note.slice(0, 200) } : {}),
    });
    if (d === 'UNAUTHORIZED' || d?.id == null) throw new ProviderRequestError('Flutterwave did not accept the refund');
    return { providerReference: d.flw_ref ?? String(d.id), status: mapFlwRefund(d.status), raw: d };
  }

  async getRefund(creds: ProviderCredentials, providerReference: string) {
    const d = await this.request<Array<{ status: string; flw_ref: string }>>(creds, 'GET', `/refunds?flw_ref=${encodeURIComponent(providerReference)}`);
    if (d === 'UNAUTHORIZED') throw new ProviderRequestError('Flutterwave rejected the API key');
    const row = Array.isArray(d) ? d.find((r) => r.flw_ref === providerReference) ?? null : null;
    return { status: row ? mapFlwRefund(row.status) : ('PROCESSING' as RefundStatus), raw: row };
  }

  async createSubaccount(creds: ProviderCredentials, input: { businessName: string; bankCode: string; accountNumber: string; contactEmail?: string; contactPhone?: string }) {
    const d = await this.request<{ subaccount_id: string }>(creds, 'POST', '/subaccounts', {
      account_bank: input.bankCode, account_number: input.accountNumber, business_name: input.businessName.slice(0, 100), country: 'NG',
      business_mobile: (input.contactPhone ?? '').replace(/^\+234/, '0'), ...(input.contactEmail ? { business_email: input.contactEmail } : {}),
      // LiveSell's commission is set on each payment (transaction_charge), so the default split takes nothing.
      split_type: 'flat', split_value: 0,
    });
    if (d === 'UNAUTHORIZED' || !d?.subaccount_id) throw new ProviderRequestError('Flutterwave did not create the subaccount');
    return { subaccountCode: d.subaccount_id };
  }

  async resolveAccount(creds: ProviderCredentials, input: { bankCode: string; accountNumber: string }) {
    try {
      const d = await this.request<{ account_name: string }>(creds, 'POST', '/accounts/resolve', { account_number: input.accountNumber, account_bank: input.bankCode });
      return d === 'UNAUTHORIZED' || !d?.account_name ? null : { accountName: d.account_name };
    } catch (e) {
      if (e instanceof ProviderRequestError) return null; // 400 "invalid account"
      throw e;
    }
  }

  async listBanks(creds: ProviderCredentials | null) {
    if (!creds) return [];
    const d = await this.request<Array<{ code: string; name: string }>>(creds, 'GET', '/banks/NG');
    if (d === 'UNAUTHORIZED' || !Array.isArray(d)) return [];
    return d.map((b) => ({ name: b.name, code: b.code })).sort((a, b) => a.name.localeCompare(b.name));
  }

  getSupportedPaymentMethods() {
    return ['card', 'banktransfer', 'ussd', 'account'];
  }

  private async request<T>(creds: ProviderCredentials, method: string, path: string, body?: unknown, opts: { allow401?: boolean } = {}): Promise<T | 'UNAUTHORIZED'> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${creds.secretKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      this.logger.warn(`Flutterwave ${method} ${path.split('?')[0]} unreachable: ${(e as Error).name}`);
      throw new ProviderUnavailableError('Flutterwave could not be reached');
    }
    if (res.status >= 500 || res.status === 429) {
      this.logger.warn(`Flutterwave ${method} ${path.split('?')[0]} → ${res.status}`);
      throw new ProviderUnavailableError(`Flutterwave is unavailable (${res.status})`);
    }
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (res.status === 401) {
      if (opts.allow401) return 'UNAUTHORIZED';
      throw new ProviderRequestError('Flutterwave rejected the API key');
    }
    if (!res.ok || json?.status !== 'success') {
      const detail = typeof json?.data === 'string' ? `: ${json.data}` : '';
      throw new ProviderRequestError(`${json?.message ?? `Flutterwave request failed (${res.status})`}${detail}`.slice(0, 300));
    }
    return json.data as T;
  }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Flutterwave transaction status → ours. */
export function mapFlwStatus(s: string | undefined): VerifiedStatus {
  switch (s) {
    case 'successful': return 'SUCCEEDED';
    case 'failed': return 'FAILED';
    case 'cancelled': return 'ABANDONED';
    default: return 'PENDING'; // pending, ongoing…
  }
}

/** Refund statuses seen in Flutterwave's reference: "completed", "completed-mpgs"; failures as "failed"/"error". */
export function mapFlwRefund(s: string | undefined): RefundStatus {
  if (!s) return 'PROCESSING';
  if (/^completed|^successful$|^success$/.test(s)) return 'SUCCEEDED';
  if (/^failed$|^error$|^declined$/.test(s)) return 'FAILED';
  return 'PROCESSING';
}
