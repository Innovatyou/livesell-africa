import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  InitializePaymentInput, PaymentProvider, ProviderCapabilities, ProviderCredentials, ProviderRequestError, ProviderUnavailableError, RefundInput,
  RefundStatus, VerifiedStatus, VerifyPaymentResult, WebhookEvent,
} from './payment-provider';

const BASE = 'https://api.paystack.co';
const TIMEOUT_MS = 15_000;

interface Envelope<T> { status: boolean; message: string; data?: T; code?: string; type?: string }

/**
 * Paystack REST adapter. Request fields follow Paystack's official OpenAPI spec (PaystackHQ/openapi,
 * dist/paystack.yaml): initialize {email, amount (kobo), currency, reference, callback_url, metadata (string),
 * subaccount, transaction_charge, bearer}; verify /transaction/verify/{reference}; refund {transaction, amount,
 * currency, merchant_note}; subaccount {business_name, settlement_bank, account_number, percentage_charge};
 * bank list / resolve. Response fields were confirmed against the sandbox (status "abandoned", amount in kobo,
 * fees, paid_at, numeric id, domain "test"; errors {status:false, message, code}).
 *
 * WEBHOOK SIGNATURE: not covered by the spec and the docs site could not be fetched. `parseWebhook` implements
 * HMAC-SHA512 of the raw body with the secret key in `x-paystack-signature`; it stays behind
 * PAYSTACK_WEBHOOKS_ENABLED=false until that is confirmed from Paystack's documentation. Payments never depend on
 * it: every webhook only triggers a server-side verify call.
 */
@Injectable()
export class PaystackAdapter implements PaymentProvider {
  readonly code = 'PAYSTACK' as const;
  readonly displayName = 'Paystack';
  readonly capabilities: ProviderCapabilities = { split: true, multipleRefunds: true, minRefundMinor: 1n, webhookSecret: 'secret_key', requiresPublicCallback: false };
  private readonly logger = new Logger(PaystackAdapter.name);

  keyMode(secretKey: string) {
    const m = /^sk_(test|live)_[A-Za-z0-9]{10,}$/.exec(secretKey.trim());
    return m ? (m[1] as 'test' | 'live') : null;
  }

  async validateCredentials(creds: ProviderCredentials) {
    // /bank is public (answers without a valid key), so it can't prove a key works; /transaction needs one.
    const res = await this.request<unknown>(creds, 'GET', '/transaction?perPage=1', undefined, { allow401: true });
    return { valid: res !== 'UNAUTHORIZED', testMode: creds.secretKey.startsWith('sk_test_') };
  }

  async initializePayment(creds: ProviderCredentials, input: InitializePaymentInput) {
    const body: Record<string, unknown> = {
      email: input.customerEmail, amount: input.amountMinor.toString(), currency: input.currency, reference: input.reference,
      callback_url: input.callbackUrl, metadata: JSON.stringify(input.metadata),
    };
    if (input.split) {
      body.subaccount = input.split.subaccountCode;
      // Flat platform share, overriding the subaccount's percentage (0%). With no commission the default (0%) applies.
      if (input.split.platformChargeMinor > 0n) body.transaction_charge = input.split.platformChargeMinor.toString();
      body.bearer = 'subaccount'; // the seller's share bears Paystack's fee
    }
    const data = await this.request<{ authorization_url: string; access_code: string; reference: string }>(creds, 'POST', '/transaction/initialize', body);
    if (data === 'UNAUTHORIZED' || !data?.authorization_url) throw new ProviderRequestError('Paystack did not return a checkout link');
    return { checkoutUrl: data.authorization_url, accessCode: data.access_code };
  }

  async verifyPayment(creds: ProviderCredentials, reference: string): Promise<VerifyPaymentResult> {
    try {
      const d = await this.request<{ id: number; status: string; amount: number; currency: string; fees: number | null; paid_at: string | null; gateway_response: string | null; domain: string }>(
        creds, 'GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      if (d === 'UNAUTHORIZED') throw new ProviderRequestError('Paystack rejected the API key');
      return {
        status: mapStatus(d.status), amountMinor: d.amount == null ? null : BigInt(d.amount), currency: d.currency ?? null,
        providerReference: d.id == null ? null : String(d.id), feeMinor: d.fees == null ? null : BigInt(d.fees),
        paidAt: d.paid_at ? new Date(d.paid_at) : null, message: d.gateway_response ?? null, testMode: d.domain ? d.domain === 'test' : null, raw: d,
      };
    } catch (e) {
      if (e instanceof ProviderRequestError && e.providerCode === 'transaction_not_found') {
        return { status: 'NOT_FOUND', amountMinor: null, currency: null, providerReference: null, feeMinor: null, paidAt: null, message: e.message, testMode: null, raw: null };
      }
      throw e;
    }
  }

  parseWebhook(creds: ProviderCredentials, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const sig = headers['x-paystack-signature'];
    if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/i.test(sig)) return null;
    const expected = createHmac('sha512', creds.secretKey).update(rawBody).digest('hex');
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return null;
    let payload: { event?: string; data?: { id?: number | string; reference?: string; transaction_reference?: string; status?: string; transaction?: { reference?: string } } };
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const event = String(payload.event ?? 'unknown');
    const d = payload.data ?? {};
    const isRefund = event.startsWith('refund.');
    return {
      eventId: `${event}:${d.id ?? ''}:${d.status ?? ''}`,
      eventType: event,
      paymentReference: isRefund ? (d.transaction_reference ?? d.transaction?.reference) : d.reference,
      refundProviderReference: isRefund && d.id != null ? String(d.id) : undefined,
    };
  }

  async refundPayment(creds: ProviderCredentials, input: RefundInput) {
    const d = await this.request<{ id: number; status: string }>(creds, 'POST', '/refund', {
      transaction: input.reference, amount: input.amountMinor.toString(), currency: input.currency, ...(input.note ? { merchant_note: input.note.slice(0, 200) } : {}),
    });
    if (d === 'UNAUTHORIZED' || d?.id == null) throw new ProviderRequestError('Paystack did not accept the refund');
    return { providerReference: String(d.id), status: mapRefund(d.status), raw: d };
  }

  async getRefund(creds: ProviderCredentials, providerReference: string) {
    const d = await this.request<{ status: string }>(creds, 'GET', `/refund/${encodeURIComponent(providerReference)}`);
    if (d === 'UNAUTHORIZED') throw new ProviderRequestError('Paystack rejected the API key');
    return { status: mapRefund(d.status), raw: d };
  }

  async createSubaccount(creds: ProviderCredentials, input: { businessName: string; bankCode: string; accountNumber: string; contactEmail?: string }) {
    const d = await this.request<{ subaccount_code: string }>(creds, 'POST', '/subaccount', {
      business_name: input.businessName.slice(0, 100), settlement_bank: input.bankCode, account_number: input.accountNumber,
      // The platform share is always set per transaction (transaction_charge), so the default split is 0%.
      percentage_charge: 0, ...(input.contactEmail ? { primary_contact_email: input.contactEmail } : {}),
    });
    if (d === 'UNAUTHORIZED' || !d?.subaccount_code) throw new ProviderRequestError('Paystack did not create the subaccount');
    return { subaccountCode: d.subaccount_code };
  }

  async resolveAccount(creds: ProviderCredentials, input: { bankCode: string; accountNumber: string }) {
    try {
      const d = await this.request<{ account_name: string }>(creds, 'GET', `/bank/resolve?account_number=${encodeURIComponent(input.accountNumber)}&bank_code=${encodeURIComponent(input.bankCode)}`);
      return d === 'UNAUTHORIZED' || !d?.account_name ? null : { accountName: d.account_name };
    } catch (e) {
      if (e instanceof ProviderRequestError) return null; // 422 "Could not resolve account name"
      throw e;
    }
  }

  async listBanks(_creds: ProviderCredentials | null = null) {
    const d = await this.request<Array<{ name: string; code: string; active: boolean; is_deleted: boolean }>>({ secretKey: '' }, 'GET', '/bank?country=nigeria&perPage=100&use_cursor=false', undefined, { noAuth: true });
    if (d === 'UNAUTHORIZED' || !Array.isArray(d)) return [];
    return d.filter((b) => b.active && !b.is_deleted).map((b) => ({ name: b.name, code: b.code }));
  }

  getSupportedPaymentMethods() {
    return ['card', 'bank', 'ussd', 'qr', 'bank_transfer'];
  }

  private async request<T>(creds: ProviderCredentials, method: string, path: string, body?: unknown, opts: { allow401?: boolean; noAuth?: boolean } = {}): Promise<T | 'UNAUTHORIZED'> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers: { ...(opts.noAuth ? {} : { Authorization: `Bearer ${creds.secretKey}` }), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      this.logger.warn(`Paystack ${method} ${path.split('?')[0]} unreachable: ${(e as Error).name}`);
      throw new ProviderUnavailableError('Paystack could not be reached');
    }
    if (res.status >= 500 || res.status === 429) {
      this.logger.warn(`Paystack ${method} ${path.split('?')[0]} → ${res.status}`);
      throw new ProviderUnavailableError(`Paystack is unavailable (${res.status})`);
    }
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (res.status === 401) {
      if (opts.allow401) return 'UNAUTHORIZED';
      throw new ProviderRequestError('Paystack rejected the API key', json?.code);
    }
    if (!res.ok || !json?.status) throw new ProviderRequestError(json?.message ?? `Paystack request failed (${res.status})`, json?.code);
    return json.data as T;
  }
}

/** Paystack transaction status → ours. Anything unrecognised is treated as not-yet-final. */
export function mapStatus(s: string | undefined): VerifiedStatus {
  switch (s) {
    case 'success': return 'SUCCEEDED';
    case 'failed': return 'FAILED';
    case 'abandoned': return 'ABANDONED';
    case 'reversed': return 'REVERSED';
    default: return 'PENDING'; // ongoing, pending, processing, queued, ...
  }
}

export function mapRefund(s: string | undefined): RefundStatus {
  switch (s) {
    case 'processed': return 'SUCCEEDED';
    case 'failed': return 'FAILED';
    default: return 'PROCESSING';
  }
}
