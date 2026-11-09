import {
  BusinessCheckResult, DeliveryState, EmailMessage, MessageChannel, MessagingNotConfiguredError, MessagingProvider, MessagingRejectedError,
  MessagingStatus, MessagingUnavailableError, SendResult, SmsMessage, VerificationProvider, WhatsappMessage, WhatsappTemplateInfo,
} from '../src/messaging/messaging-provider';
import { createHmac, randomBytes } from 'node:crypto';
import type { PaymentProviderCode } from '../src/generated/prisma/client';
import { BachsAdapter } from '../src/payments/bachs.adapter';
import { FlutterwaveAdapter } from '../src/payments/flutterwave.adapter';
import {
  InitializePaymentInput, PaymentProvider, PaymentProviderRegistry, ProviderCapabilities, ProviderCredentials, ProviderRequestError,
  ProviderUnavailableError, RefundInput, RefundStatus, VerifyPaymentResult, WebhookEvent,
} from '../src/payments/payment-provider';
import { PaystackAdapter } from '../src/payments/paystack.adapter';
import { AuthMailer, StaffInvitationMessage } from '../src/auth/auth-mailer';
import { BillingNotifier, ExpiredMessage, OverdueMessage, ReminderMessage, CommissionInvoiceMessage } from '../src/billing/billing-notifier';

/** Per test file (Jest loads this module fresh for each): keeps fake provider references unique in the shared test DB. */
const RUN = randomBytes(4).toString('hex');

/** Captures what the mailer would send, so flows can be completed without a real email/SMS provider. */
export class CapturingMailer extends AuthMailer {
  canSendSms = true;
  verify = new Map<string, string>();
  reset = new Map<string, string>();
  invites = new Map<string, StaffInvitationMessage>();
  otp = new Map<string, string>();
  async sendEmailVerification(to: string, _n: string, token: string) { this.verify.set(to, token); }
  async sendPasswordReset(to: string, _n: string, token: string) { this.reset.set(to, token); }
  async sendStaffInvitation(to: string, m: StaffInvitationMessage) { this.invites.set(to, m); }
  async sendPhoneOtp(to: string, code: string) { this.otp.set(to, code); }
}

export class CapturingBillingNotifier extends BillingNotifier {
  reminders: Array<{ to: string } & ReminderMessage> = [];
  overdue: Array<{ to: string } & OverdueMessage> = [];
  expired: Array<{ to: string } & ExpiredMessage> = [];
  failNext = 0;
  async sendRenewalReminder(to: string, m: ReminderMessage) {
    if (this.failNext > 0) { this.failNext--; throw new Error('provider unavailable'); }
    this.reminders.push({ to, ...m });
  }
  async sendPaymentOverdue(to: string, m: OverdueMessage) { this.overdue.push({ to, ...m }); }
  async sendSubscriptionExpired(to: string, m: ExpiredMessage) { this.expired.push({ to, ...m }); }
  commissionInvoices: Array<{ to: string } & CommissionInvoiceMessage> = [];
  async sendCommissionInvoice(to: string, m: CommissionInvoiceMessage) { this.commissionInvoices.push({ to, ...m }); }
}

// ───────────────────────── Payments ─────────────────────────

/**
 * Scriptable stand-in for Paystack. Tests set what "the provider" will answer on verify, and the service under test
 * has to reach the right conclusion. Webhook signatures use the real adapter's verification.
 */
export class FakePaymentProvider implements PaymentProvider {
  /** Real adapter for this code: key formats, capabilities and webhook signatures behave exactly like production. */
  private readonly real: PaymentProvider;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  verifyContexts: Array<{ reference: string; providerCheckoutId?: string | null }> = [];
  constructor(readonly code: PaymentProviderCode = 'PAYSTACK') {
    this.real = code === 'FLUTTERWAVE' ? new FlutterwaveAdapter() : code === 'BACHS' ? new BachsAdapter() : new PaystackAdapter();
    this.displayName = this.real.displayName;
    this.capabilities = this.real.capabilities;
  }
  keyMode(secretKey: string) {
    return this.real.keyMode(secretKey);
  }
  down = false;
  validKeys = new Set<string>();
  initialized: Array<{ creds: ProviderCredentials; input: InitializePaymentInput }> = [];
  verifications = new Map<string, Partial<VerifyPaymentResult>>();
  verifyCalls: string[] = [];
  refundCalls: RefundInput[] = [];
  refunds = new Map<string, RefundStatus>();
  refundDecline: string | null = null;
  subaccounts: string[] = [];
  resolvable = new Map<string, string>(); // accountNumber -> account name
  private seq = 0;

  private guard() {
    if (this.down) throw new ProviderUnavailableError('Paystack could not be reached');
  }
  /** What verify will report for a reference. */
  succeed(reference: string, amountMinor: bigint, over: Partial<VerifyPaymentResult> = {}) {
    this.verifications.set(reference, { status: 'SUCCEEDED', amountMinor, currency: 'NGN', feeMinor: 1_500n, providerReference: `ps_${RUN}_${++this.seq}`, paidAt: new Date(), ...over });
  }
  async validateCredentials(creds: ProviderCredentials) {
    this.guard();
    return { valid: this.validKeys.has(creds.secretKey), testMode: this.keyMode(creds.secretKey) === 'test' };
  }
  async initializePayment(creds: ProviderCredentials, input: InitializePaymentInput) {
    this.guard();
    if (input.split && !this.capabilities.split) throw new ProviderRequestError('split not supported');
    this.initialized.push({ creds, input });
    const host = `checkout.${this.code.toLowerCase()}.test`;
    return { checkoutUrl: `https://${host}/${input.reference}`, ...(this.code === 'BACHS' ? { providerCheckoutId: `chk_${input.reference.replace(/[^A-Za-z0-9]/g, '')}` } : {}) };
  }
  async verifyPayment(_c: ProviderCredentials, reference: string, ctx: { providerCheckoutId?: string | null } = {}): Promise<VerifyPaymentResult> {
    this.guard();
    this.verifyCalls.push(reference);
    this.verifyContexts.push({ reference, providerCheckoutId: ctx.providerCheckoutId });
    const v = this.verifications.get(reference) ?? { status: 'ABANDONED' };
    return { status: 'PENDING', amountMinor: null, currency: null, providerReference: null, feeMinor: null, paidAt: null, message: null, testMode: true, raw: { fake: true }, ...v } as VerifyPaymentResult;
  }
  parseWebhook(creds: ProviderCredentials, raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    return this.real.parseWebhook(creds, raw, headers);
  }
  async refundPayment(_c: ProviderCredentials, input: RefundInput) {
    this.guard();
    if (this.refundDecline) throw new ProviderRequestError(this.refundDecline);
    this.refundCalls.push(input);
    const id = `rf_${RUN}_${++this.seq}`;
    this.refunds.set(id, 'PROCESSING');
    return { providerReference: id, status: 'PROCESSING' as RefundStatus, raw: {} };
  }
  async getRefund(_c: ProviderCredentials, id: string) {
    this.guard();
    return { status: this.refunds.get(id) ?? 'PROCESSING', raw: {} };
  }
  async createSubaccount(_c: ProviderCredentials, input: { businessName: string }) {
    this.guard();
    const code = `ACCT_fake${++this.seq}`;
    this.subaccounts.push(`${code}:${input.businessName}`);
    return { subaccountCode: code };
  }
  async resolveAccount(_c: ProviderCredentials, input: { accountNumber: string }) {
    this.guard();
    const name = this.resolvable.get(input.accountNumber);
    return name ? { accountName: name } : null;
  }
  async listBanks(_creds: ProviderCredentials | null) {
    return [{ name: 'Guaranty Trust Bank', code: '058' }, { name: 'Access Bank', code: '044' }];
  }
  getSupportedPaymentMethods() {
    return ['card'];
  }
}

export class FakeRegistry extends PaymentProviderRegistry {
  private readonly fakes: FakePaymentProvider[];
  constructor(...fakes: FakePaymentProvider[]) {
    super();
    this.fakes = fakes;
  }
  get(code: PaymentProviderCode) {
    return this.fakes.find((f) => f.code === code) ?? null;
  }
}

/** Signs a Bachs webhook (X-Bachs-Signature-V2) the way Bachs documents it. */
export function signBachsWebhook(secret: string, payload: unknown, at = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(payload);
  const v1 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return { body, header: `t=${at},v1=${v1}` };
}

/** Signs a webhook body the way the Paystack adapter verifies it. */
export function signWebhook(secretKey: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return { body, signature: createHmac('sha512', secretKey).update(body).digest('hex') };
}

// ───────────────────────── Messaging (Phase 8) ─────────────────────────

type Outcome = 'ok' | 'unavailable' | 'definite' | 'reject';

/** Scriptable stand-in for Veltrix: queue outcomes per channel; records every message and idempotency key. */
export class FakeMessaging extends MessagingProvider {
  readonly name = 'VELTRIX';
  enabled: Record<MessageChannel, boolean> = { EMAIL: true, SMS: true, WHATSAPP: true };
  next: Record<MessageChannel, Outcome[]> = { EMAIL: [], SMS: [], WHATSAPP: [] };
  sent: Array<{ channel: MessageChannel; to: string; key: string; subject?: string; html?: string; text?: string; template?: { name: string; language: string; params: string[] } }> = [];
  attempts: Array<{ channel: MessageChannel; key: string; outcome: Outcome }> = [];
  delivery = new Map<string, DeliveryState>();
  private seq = 0;
  channelEnabled(c: MessageChannel) { return this.enabled[c]; }
  private outcome(c: MessageChannel, key: string): void {
    if (!this.enabled[c]) throw new MessagingNotConfiguredError('not configured');
    const o = this.next[c].shift() ?? 'ok';
    this.attempts.push({ channel: c, key, outcome: o });
    if (o === 'unavailable') throw new MessagingUnavailableError('Veltrix could not be reached');
    if (o === 'definite') throw new MessagingUnavailableError('Veltrix tried and failed', true);
    if (o === 'reject') throw new MessagingRejectedError('Insufficient wallet balance.', 'INSUFFICIENT_BALANCE');
  }
  async sendEmail(m: EmailMessage): Promise<SendResult> {
    this.outcome('EMAIL', m.idempotencyKey);
    this.sent.push({ channel: 'EMAIL', to: m.to, key: m.idempotencyKey, subject: m.subject, html: m.html });
    return { providerMessageId: `em_${++this.seq}`, replayed: false };
  }
  async sendSms(m: SmsMessage): Promise<SendResult> {
    this.outcome('SMS', m.idempotencyKey);
    this.sent.push({ channel: 'SMS', to: m.to, key: m.idempotencyKey, text: m.text });
    return { providerMessageId: `sms_${++this.seq}`, replayed: false };
  }
  async sendWhatsapp(m: WhatsappMessage): Promise<SendResult> {
    this.outcome('WHATSAPP', m.idempotencyKey);
    this.sent.push({ channel: 'WHATSAPP', to: m.to, key: m.idempotencyKey, text: m.text, template: m.template });
    return { providerMessageId: `wamid.${++this.seq}`, replayed: false };
  }
  async smsDelivery(id: string): Promise<DeliveryState> { return this.delivery.get(id) ?? 'SENT'; }
  async status(): Promise<MessagingStatus> {
    return { configured: true, channels: { ...this.enabled }, account: { name: 'LiveSell Platform', email: 'ops@livesell.test' }, wallet: { balance: '5000.00', currency: '1' } };
  }
  forwardingUrl: string | null = null;
  templates: WhatsappTemplateInfo[] = [];
  async configureWhatsappForwarding(url: string) { this.forwardingUrl = url; return { secret: 'whfwd_test_forwarding_secret_0123456789' }; }
  async whatsappTemplates() { return this.templates; }
  last(channel: MessageChannel, to?: string) { return [...this.sent].reverse().find((s) => s.channel === channel && (!to || s.to === to)); }
}

export class FakeVerification extends VerificationProvider {
  enabled = true;
  calls: Array<{ identifier: string; name: string }> = [];
  result: BusinessCheckResult | 'unavailable' = { status: 'VERIFIED', matched: true, matchScore: 97, registeredName: 'FASHION BY ADA LTD', checkId: 'chk_fake', environment: 'sandbox', message: 'Verified' };
  async checkBusiness(input: { type: 'cac' | 'tin'; identifier: string; name: string }) {
    this.calls.push({ identifier: input.identifier, name: input.name });
    if (this.result === 'unavailable') throw new MessagingUnavailableError('Veltrix Verify could not be reached');
    return this.result;
  }
}
