import type { PaymentProviderCode } from '../generated/prisma/client';

/**
 * Provider-independent payment port (MASTER-SPEC §12). Business logic depends only on this file; each provider
 * has one adapter (Paystack, Flutterwave, Bachs; bank transfer in Phase 7). Amounts are always BigInt minor units
 * here — adapters convert to whatever the provider uses.
 * Credentials are passed per call because a payment may use the platform account or a seller's own account.
 */
export interface ProviderCredentials {
  secretKey: string;
  /** Webhook signing secret when the provider uses a separate one (Flutterwave secret hash, Bachs endpoint secret). */
  webhookSecret?: string | null;
}

export interface InitializePaymentInput {
  reference: string;
  amountMinor: bigint;
  currency: string;
  customerEmail: string;
  customerName?: string | null;
  callbackUrl: string;
  metadata: Record<string, string>;
  /** Split settlement: pay into the platform account, send everything but `platformChargeMinor` to the subaccount. */
  split?: { subaccountCode: string; platformChargeMinor: bigint };
}

export interface InitializePaymentResult {
  checkoutUrl: string;
  accessCode?: string;
  /** Provider's id for the checkout (Bachs `chk_…`), when verification needs it rather than our reference. */
  providerCheckoutId?: string;
}

export type VerifiedStatus = 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'ABANDONED' | 'REVERSED' | 'NOT_FOUND';

export interface VerifyPaymentResult {
  status: VerifiedStatus;
  /** Amount actually received, in minor units. Compared exactly with what we asked for. */
  amountMinor: bigint | null;
  currency: string | null;
  providerReference: string | null; // provider's own transaction/charge id (used for refunds)
  feeMinor: bigint | null;
  paidAt: Date | null;
  message: string | null;
  testMode: boolean | null;
  raw: unknown;
}

export interface WebhookEvent {
  eventId: string;
  eventType: string;
  /** Our payment reference (we always re-verify with the provider; the payload is never trusted for money). */
  paymentReference?: string;
  providerCheckoutId?: string;
  refundProviderReference?: string;
}

export type RefundStatus = 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

export interface RefundInput {
  /** Our payment reference. */
  reference: string;
  /** The provider's transaction/charge id recorded at verification. */
  providerReference: string | null;
  amountMinor: bigint;
  currency: string;
  note?: string;
  /** Our refund id: unique per refund, used as the provider's reference / idempotency key where supported. */
  refundId: string;
}

export interface ProviderCapabilities {
  /** Platform-collected payments with a seller subaccount and a flat platform charge. */
  split: boolean;
  /** More than one refund per payment (Bachs allows exactly one). */
  multipleRefunds: boolean;
  /** Smallest refund the provider accepts, in minor units (NGN). */
  minRefundMinor: bigint;
  /** Where the webhook signing secret comes from. */
  webhookSecret: 'secret_key' | 'separate';
  /** The provider rejects non-public callback URLs (e.g. localhost). */
  requiresPublicCallback: boolean;
}

export interface PaymentProvider {
  readonly code: PaymentProviderCode;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** Key-format check before any network call: returns the mode, or null if the key doesn't look like this provider's. */
  keyMode(secretKey: string): 'test' | 'live' | null;
  validateCredentials(creds: ProviderCredentials): Promise<{ valid: boolean; testMode: boolean }>;
  initializePayment(creds: ProviderCredentials, input: InitializePaymentInput): Promise<InitializePaymentResult>;
  verifyPayment(creds: ProviderCredentials, reference: string, ctx?: { providerCheckoutId?: string | null }): Promise<VerifyPaymentResult>;
  /** Returns null when the signature does not verify. */
  parseWebhook(creds: ProviderCredentials, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null;
  refundPayment(creds: ProviderCredentials, input: RefundInput): Promise<{ providerReference: string; status: RefundStatus; raw: unknown }>;
  getRefund(creds: ProviderCredentials, providerReference: string): Promise<{ status: RefundStatus; raw: unknown }>;
  createSubaccount(creds: ProviderCredentials, input: { businessName: string; bankCode: string; accountNumber: string; contactEmail?: string; contactPhone?: string }): Promise<{ subaccountCode: string }>;
  resolveAccount(creds: ProviderCredentials, input: { bankCode: string; accountNumber: string }): Promise<{ accountName: string } | null>;
  /** Nigerian banks; some providers need a key for this (null = none available). */
  listBanks(creds: ProviderCredentials | null): Promise<Array<{ name: string; code: string }>>;
  getSupportedPaymentMethods(): string[];
}

/** The provider is down / timing out / returned a 5xx. Nothing about the payment is concluded (§26 #11). */
export class ProviderUnavailableError extends Error {}
/** The provider rejected the request (bad params, declined). Carries the provider's message. */
export class ProviderRequestError extends Error {
  constructor(message: string, public readonly providerCode?: string) {
    super(message);
  }
}
/** The adapter doesn't support this operation (e.g. split settlement on Bachs before Connect is enabled). */
export class ProviderCapabilityError extends Error {}

/** Resolves adapters by provider code. The registry is the only place that knows which adapters exist. */
export abstract class PaymentProviderRegistry {
  abstract get(code: PaymentProviderCode): PaymentProvider | null;
}

/** True for URLs a provider can redirect a customer to (not localhost / private networks). */
export function isPublicUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    return !(h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '0.0.0.0' || h === '[::1]');
  } catch {
    return false;
  }
}
