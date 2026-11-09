/**
 * Messaging port (MASTER-SPEC §15). Business logic depends on this file only; Veltrix is one adapter.
 * Every send carries an idempotency key, so a retry after a timeout never sends the same message twice.
 */
export type MessageChannel = 'EMAIL' | 'SMS' | 'WHATSAPP';

export interface EmailMessage { to: string; toName?: string; subject: string; html: string; replyTo?: string; idempotencyKey: string }
export interface SmsMessage { to: string; text: string; idempotencyKey: string }
export interface WhatsappMessage {
  to: string;
  /** Free-form text only reaches someone who messaged the number in the last 24 h; otherwise use an approved template. */
  text?: string;
  template?: { name: string; language: string; params: string[] };
  idempotencyKey: string;
}

export interface SendResult { providerMessageId: string | null; replayed: boolean }
export type DeliveryState = 'SENT' | 'DELIVERED' | 'FAILED' | 'UNKNOWN';

export interface MessagingStatus {
  configured: boolean;
  channels: Record<MessageChannel, boolean>;
  account?: { name: string | null; email: string | null } | null;
  wallet?: { balance: string; currency: string | null } | null;
  error?: string;
}

/**
 * Temporary: outage, timeout, 5xx, 429, or a send still in progress. Retried with backoff.
 * `definite` = the provider answered that this attempt failed (nothing went out), so the next attempt may use a
 * new idempotency key; otherwise the outcome is unknown and the retry must reuse the same key.
 */
export class MessagingUnavailableError extends Error {
  constructor(message: string, public readonly definite = false) {
    super(message);
  }
}
/** Permanent for this message: bad destination, insufficient wallet balance, channel disabled. Not retried. */
export class MessagingRejectedError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}
/** The platform has not configured this channel. Nothing was attempted. */
export class MessagingNotConfiguredError extends Error {}

export abstract class MessagingProvider {
  abstract readonly name: string;
  abstract channelEnabled(channel: MessageChannel): boolean;
  abstract sendEmail(m: EmailMessage): Promise<SendResult>;
  abstract sendSms(m: SmsMessage): Promise<SendResult>;
  abstract sendWhatsapp(m: WhatsappMessage): Promise<SendResult>;
  /** Latest delivery state of an SMS (provider delivery receipt), when the provider reports one. */
  abstract smsDelivery(providerMessageId: string): Promise<DeliveryState>;
  abstract status(): Promise<MessagingStatus>;
  /** Ask the provider to forward the platform WhatsApp number's inbound messages to `url`. Returns the signing secret. */
  abstract configureWhatsappForwarding(url: string): Promise<{ secret: string }>;
  /** Approved templates on the platform WhatsApp number. */
  abstract whatsappTemplates(): Promise<WhatsappTemplateInfo[]>;
}

/** `named`: the template uses named values ({{customer_name}}); LiveSell sends values by position, so those can't be used. */
export interface WhatsappTemplateInfo { name: string; language: string; category: string; params: number; header: string | null; named?: boolean }

// ───────────────────────── Verification (Veltrix Verify) ─────────────────────────

export interface BusinessCheckResult {
  status: 'VERIFIED' | 'MISMATCH' | 'NOT_FOUND' | 'ERROR' | 'PENDING';
  matched: boolean;
  matchScore: number | null;
  registeredName: string | null;
  checkId: string | null;
  environment: string | null;
  message: string | null;
}

export abstract class VerificationProvider {
  abstract readonly enabled: boolean;
  /** Registry lookup of a CAC RC/BN number (or TIN) against the name the seller gave. */
  abstract checkBusiness(input: { type: 'cac' | 'tin'; identifier: string; name: string; idempotencyKey: string }): Promise<BusinessCheckResult>;
}
