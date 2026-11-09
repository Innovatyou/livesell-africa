import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DecimalAmountError, decimalToMinor, minorToDecimal } from './money-decimal';
import {
  InitializePaymentInput, isPublicUrl, PaymentProvider, ProviderCapabilities, ProviderCapabilityError, ProviderCredentials, ProviderRequestError,
  ProviderUnavailableError, RefundInput, RefundStatus, VerifiedStatus, VerifyPaymentResult, WebhookEvent,
} from './payment-provider';

const TIMEOUT_MS = 20_000;
const WEBHOOK_TOLERANCE_S = 300;

interface Charge {
  payment_id: string; status: string; amount: string; amount_paid: string | null; currency: string; completed_at: string | null;
  fees: { amount: string; currency: string } | null; message: string | null;
}
interface Session { checkout_id: string; status: string; reference: string | null; amount: string; currency: string; charge: Charge | null }

/**
 * Bachs adapter (REST, no SDK — the SDK lacks refunds and Connect). Sources: docs.bachs.io "Accept a payment with
 * Checkout", "Payment statuses", "Issue a refund", "Set up webhooks", API reference (checkout sessions, refunds) and
 * the Node SDK page. Confirmed against the sandbox:
 *  - base URL from the key: sk_sandbox_ → sandbox-api.bachs.io, sk_live_ → api.bachs.io;
 *  - money is a decimal string in the currency ("2500.00"); a raw-amount checkout uses `pricing`;
 *  - `reference` must be unique forever (duplicate → 400); success_url must be public (localhost → 400);
 *  - GET /v1/checkout-sessions/{id} carries `charge.payment_id` (`ch_…`), which refunds take as `charge_id`;
 *  - errors are `{ detail, error_code }`.
 * Webhooks: `X-Bachs-Signature-V2: t=…,v1=…` = HMAC-SHA256 hex of "{t}.{raw body}" with the endpoint's signing
 * secret, 300 s tolerance, any v1 may match (documented). A payment takes exactly ONE refund.
 * Split (Bachs Connect) needs the platform's `connect` capability and seller onboarding: not enabled here.
 */
@Injectable()
export class BachsAdapter implements PaymentProvider {
  readonly code = 'BACHS' as const;
  readonly displayName = 'Bachs';
  readonly capabilities: ProviderCapabilities = { split: false, multipleRefunds: false, minRefundMinor: 1n, webhookSecret: 'separate', requiresPublicCallback: true };
  private readonly logger = new Logger(BachsAdapter.name);

  keyMode(secretKey: string) {
    const m = /^sk_(sandbox|live)_[A-Za-z0-9_-]{16,}$/.exec(secretKey.trim());
    return m ? (m[1] === 'sandbox' ? 'test' : 'live') : null;
  }

  async validateCredentials(creds: ProviderCredentials) {
    const r = await this.request<unknown>(creds, 'GET', '/v1/payments?limit=1', undefined, { allow401: true });
    return { valid: r !== 'UNAUTHORIZED', testMode: this.keyMode(creds.secretKey) === 'test' };
  }

  async initializePayment(creds: ProviderCredentials, input: InitializePaymentInput) {
    if (input.split) throw new ProviderCapabilityError('Split settlement is not available on Bachs');
    const body: Record<string, unknown> = {
      pricing: { currency: input.currency, amount: minorToDecimal(input.amountMinor) },
      customer: { email: input.customerEmail, ...(input.customerName ? { name: input.customerName.slice(0, 100) } : {}) },
      reference: input.reference, metadata: input.metadata, expires_in_minutes: 1440,
    };
    // Bachs refuses non-public redirect URLs (also in the sandbox); without one the customer stays on Bachs's page.
    if (isPublicUrl(input.callbackUrl)) {
      body.success_url = withParam(input.callbackUrl, 'reference', input.reference);
      body.cancel_url = withParam(input.callbackUrl, 'reference', input.reference);
    }
    const d = await this.request<{ checkout_id: string; checkout_url: string }>(creds, 'POST', '/v1/checkout-sessions', body, { idempotencyKey: input.reference });
    if (d === 'UNAUTHORIZED' || !d?.checkout_url || !d.checkout_id) throw new ProviderRequestError('Bachs did not return a checkout link');
    return { checkoutUrl: d.checkout_url, providerCheckoutId: d.checkout_id };
  }

  async verifyPayment(creds: ProviderCredentials, reference: string, ctx: { providerCheckoutId?: string | null } = {}): Promise<VerifyPaymentResult> {
    const testMode = this.keyMode(creds.secretKey) === 'test';
    const none = (message: string): VerifyPaymentResult => ({ status: 'NOT_FOUND', amountMinor: null, currency: null, providerReference: null, feeMinor: null, paidAt: null, message, testMode, raw: null });
    if (!ctx.providerCheckoutId) return none('No Bachs checkout id recorded');
    let s: Session | 'UNAUTHORIZED';
    try {
      s = await this.request<Session>(creds, 'GET', `/v1/checkout-sessions/${encodeURIComponent(ctx.providerCheckoutId)}`);
    } catch (e) {
      if (e instanceof ProviderRequestError && e.providerCode === 'NOT_FOUND') return none(e.message);
      throw e;
    }
    if (s === 'UNAUTHORIZED') throw new ProviderRequestError('Bachs rejected the API key');
    if (s.reference && s.reference !== reference) throw new ProviderRequestError('Bachs returned a different checkout');
    const c = s.charge;
    if (!c) {
      const status: VerifiedStatus = s.status === 'expired' || s.status === 'cancelled' ? 'ABANDONED' : 'PENDING';
      return { ...none(s.status), status };
    }
    const status = mapBachsCharge(c.status);
    let amountMinor: bigint | null = null;
    try {
      amountMinor = decimalToMinor(c.amount_paid ?? (status === 'SUCCEEDED' ? c.amount : '0'));
    } catch (e) {
      if (!(e instanceof DecimalAmountError)) throw e;
    }
    const fee = c.fees && c.fees.currency === c.currency ? decimalToMinor(c.fees.amount, { round: true }) : null;
    return {
      status, amountMinor, currency: c.currency ?? null, providerReference: c.payment_id ?? null, feeMinor: fee,
      paidAt: c.completed_at ? new Date(c.completed_at) : null, message: c.message ?? null, testMode, raw: s,
    };
  }

  parseWebhook(creds: ProviderCredentials, rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now = Date.now()): WebhookEvent | null {
    const secret = creds.webhookSecret;
    const header = headers['x-bachs-signature-v2'];
    if (!secret || typeof header !== 'string') return null;
    const parts = header.split(',').map((p) => p.trim().split('=', 2) as [string, string]);
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    const sigs = parts.filter(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/i.test(v ?? '')).map(([, v]) => v);
    if (!Number.isInteger(t) || !sigs.length || Math.abs(now / 1000 - t) > WEBHOOK_TOLERANCE_S) return null;
    const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
    if (!sigs.some((s) => timingSafeEqual(expected, Buffer.from(s, 'hex')))) return null;
    let p: { id?: string; type?: string; data?: { checkout_id?: string | null; reference?: string | null; refund_id?: string | null } };
    try {
      p = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    if (!p.id || !p.type) return null;
    const d = p.data ?? {};
    const isRefund = p.type.startsWith('refund.');
    return {
      eventId: p.id, eventType: p.type,
      ...(isRefund ? { refundProviderReference: d.refund_id ?? undefined } : { paymentReference: d.reference ?? undefined, providerCheckoutId: d.checkout_id ?? undefined }),
    };
  }

  async refundPayment(creds: ProviderCredentials, input: RefundInput) {
    if (!input.providerReference) throw new ProviderRequestError('This payment has no Bachs charge id to refund');
    const d = await this.request<{ refund_id: string; status: string }>(creds, 'POST', '/v1/refunds', {
      charge_id: input.providerReference, reference: input.refundId, amount: minorToDecimal(input.amountMinor), idempotency_key: input.refundId,
      ...(input.note ? { reason: input.note.slice(0, 200) } : {}),
    }, { idempotencyKey: input.refundId });
    if (d === 'UNAUTHORIZED' || !d?.refund_id) throw new ProviderRequestError('Bachs did not accept the refund');
    return { providerReference: d.refund_id, status: mapBachsRefund(d.status), raw: d };
  }

  async getRefund(creds: ProviderCredentials, providerReference: string) {
    const d = await this.request<{ status: string }>(creds, 'GET', `/v1/refunds/${encodeURIComponent(providerReference)}`);
    if (d === 'UNAUTHORIZED') throw new ProviderRequestError('Bachs rejected the API key');
    return { status: mapBachsRefund(d.status), raw: d };
  }

  async createSubaccount(): Promise<{ subaccountCode: string }> {
    throw new ProviderCapabilityError('Split settlement is not available on Bachs');
  }

  async resolveAccount(): Promise<{ accountName: string } | null> {
    throw new ProviderCapabilityError('Account resolution is not used for Bachs');
  }

  async listBanks() {
    return [];
  }

  getSupportedPaymentMethods() {
    return ['NGN_CARD', 'NGN_BANK_TRANSFER', 'USD_CARD', 'MOBILE_MONEY'];
  }

  private base(secretKey: string) {
    return this.keyMode(secretKey) === 'live' ? 'https://api.bachs.io' : 'https://sandbox-api.bachs.io';
  }

  private async request<T>(creds: ProviderCredentials, method: string, path: string, body?: unknown, opts: { allow401?: boolean; idempotencyKey?: string } = {}): Promise<T | 'UNAUTHORIZED'> {
    let res: Response;
    try {
      res = await fetch(`${this.base(creds.secretKey)}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${creds.secretKey}`, 'Content-Type': 'application/json', Accept: 'application/json',
          ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      this.logger.warn(`Bachs ${method} ${path.split('?')[0]} unreachable: ${(e as Error).name}`);
      throw new ProviderUnavailableError('Bachs could not be reached');
    }
    if (res.status >= 500 || res.status === 429) {
      this.logger.warn(`Bachs ${method} ${path.split('?')[0]} → ${res.status}`);
      throw new ProviderUnavailableError(`Bachs is unavailable (${res.status})`);
    }
    const json = (await res.json().catch(() => null)) as (T & { detail?: string; error_code?: string }) | null;
    if (res.status === 401) {
      if (opts.allow401) return 'UNAUTHORIZED';
      throw new ProviderRequestError('Bachs rejected the API key', 'UNAUTHORIZED');
    }
    if (!res.ok) {
      const detail = typeof json?.detail === 'string' ? json.detail : `Bachs request failed (${res.status})`;
      throw new ProviderRequestError(detail.slice(0, 300), json?.error_code);
    }
    return json as T;
  }
}

function withParam(url: string, k: string, v: string) {
  const u = new URL(url);
  u.searchParams.set(k, v);
  u.searchParams.set('provider', 'bachs');
  return u.toString();
}

/** Bachs charge status → ours ("Payment statuses" guide + PaymentResponse enum). */
export function mapBachsCharge(s: string | undefined): VerifiedStatus {
  switch (s) {
    case 'succeeded':
    case 'partially_refunded':
      return 'SUCCEEDED';
    // Money arrived but not the amount asked for: reported as received so the exact-amount check flags it.
    case 'accepted':
    case 'underpaid':
    case 'overpaid':
      return 'SUCCEEDED';
    case 'failed': return 'FAILED';
    case 'refunded':
    case 'auto_refunded':
      return 'REVERSED';
    case 'incomplete':
    case 'expired':
    case 'cancelled':
      return 'ABANDONED';
    default: return 'PENDING'; // open, created, processing
  }
}

/** Refund statuses: "processing", "success" (API) / "paid" (webhook), "failed". */
export function mapBachsRefund(s: string | undefined): RefundStatus {
  if (s === 'success' || s === 'paid' || s === 'succeeded') return 'SUCCEEDED';
  if (s === 'failed') return 'FAILED';
  return 'PROCESSING';
}
