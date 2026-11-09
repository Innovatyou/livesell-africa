import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import {
  BusinessCheckResult, DeliveryState, EmailMessage, MessageChannel, MessagingNotConfiguredError, MessagingProvider, MessagingRejectedError,
  MessagingStatus, MessagingUnavailableError, SendResult, SmsMessage, VerificationProvider, WhatsappMessage, WhatsappTemplateInfo,
} from './messaging-provider';

const TIMEOUT_MS = 20_000;

interface Envelope<T> { status: 'success' | 'error'; data?: T; error?: string }

/**
 * Veltrix customer API (`/api/v1`). Endpoints and fields follow the Veltrix source (C:\laragon\www\mailwizz-yii3:
 * config/api/routes.php, docs/API.md and the controllers), not guesses:
 *  - auth: `X-MW-PUBLIC-KEY: <key>`; envelope `{ status, data | error }`;
 *  - email: POST /transactional-emails { to_email, to_name, subject, body (HTML), from_email, from_name, reply_to }
 *    → data.record { email_uid, status: sent|error };
 *  - SMS:   POST /sms-tools/quick-send { sender, message, recipients } → data { sent, failed, results[{ recipient,
 *    status, message_id, error }] }; delivery receipt via GET /sms-tools/logs?message_id=…;
 *  - WhatsApp: POST /whatsapp/send { server_uid, phone, message_type: text|template, message, template_name,
 *    template_language, template_params ("a|b|c") } → data { message_id };
 *  - all three sends accept `Idempotency-Key` (Veltrix migration 174) and replay with `Idempotent-Replayed: true`.
 * Status codes: 402 wallet, 403 channel disabled, 404 unknown server, 422 validation → rejected (not retried);
 * 409 (same key still running), 429, 5xx, network → unavailable (retried).
 */
@Injectable()
export class VeltrixMessagingAdapter extends MessagingProvider {
  readonly name = 'VELTRIX';
  private readonly logger = new Logger(VeltrixMessagingAdapter.name);

  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  private get base() {
    return `${this.config.get('VELTRIX_BASE_URL', { infer: true })?.replace(/\/+$/, '')}/api/v1`;
  }
  private get enabled() {
    return this.config.get('VELTRIX_ENABLED', { infer: true }) && !!this.config.get('VELTRIX_BASE_URL', { infer: true }) && !!this.config.get('VELTRIX_API_KEY', { infer: true });
  }

  channelEnabled(channel: MessageChannel): boolean {
    if (!this.enabled) return false;
    if (channel === 'EMAIL') return !!this.config.get('VELTRIX_EMAIL_FROM', { infer: true });
    if (channel === 'SMS') return !!this.config.get('VELTRIX_SMS_SENDER', { infer: true });
    return !!this.config.get('VELTRIX_WHATSAPP_SERVER_UID', { infer: true });
  }

  async sendEmail(m: EmailMessage): Promise<SendResult> {
    this.require('EMAIL');
    const r = await this.post<{ record: { email_uid: string; status: string } }>('/transactional-emails', {
      to_email: m.to, ...(m.toName ? { to_name: m.toName } : {}), subject: m.subject, body: m.html,
      from_email: this.config.get('VELTRIX_EMAIL_FROM', { infer: true }), from_name: this.config.get('VELTRIX_EMAIL_FROM_NAME', { infer: true }),
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
    }, m.idempotencyKey);
    const rec = r.data?.record;
    if (!rec?.email_uid) throw new MessagingUnavailableError('Veltrix did not confirm the email');
    if (rec.status === 'error') throw new MessagingRejectedError('Veltrix could not send the email', 'EMAIL_FAILED');
    return { providerMessageId: rec.email_uid, replayed: r.replayed };
  }

  async sendSms(m: SmsMessage): Promise<SendResult> {
    this.require('SMS');
    const r = await this.post<{ sent: number; failed: number; results?: Array<{ recipient: string; status: string; message_id: string | null; error: string | null }> }>(
      '/sms-tools/quick-send', { sender: this.config.get('VELTRIX_SMS_SENDER', { infer: true }), message: m.text, recipients: m.to }, m.idempotencyKey);
    const d = r.data;
    if (!d) throw new MessagingUnavailableError('Veltrix did not confirm the SMS');
    const first = d.results?.[0];
    if (d.sent < 1) throw new MessagingRejectedError(first?.error ?? 'The SMS gateway rejected the message', 'SMS_REJECTED');
    return { providerMessageId: first?.message_id ?? null, replayed: r.replayed };
  }

  async sendWhatsapp(m: WhatsappMessage): Promise<SendResult> {
    this.require('WHATSAPP');
    if (!m.text && !m.template) throw new MessagingRejectedError('A WhatsApp message needs text or a template', 'EMPTY');
    const body: Record<string, unknown> = { server_uid: this.config.get('VELTRIX_WHATSAPP_SERVER_UID', { infer: true }), phone: m.to };
    if (m.template) {
      // Veltrix splits template values on "|", so a value may not contain one.
      Object.assign(body, { message_type: 'template', template_name: m.template.name, template_language: m.template.language, template_params: m.template.params.map((p) => p.replace(/\|/g, '/')).join('|') });
    } else {
      Object.assign(body, { message_type: 'text', message: m.text });
    }
    const r = await this.post<{ message_id: string; phone: string }>('/whatsapp/send', body, m.idempotencyKey);
    return { providerMessageId: r.data?.message_id || null, replayed: r.replayed };
  }

  async smsDelivery(providerMessageId: string): Promise<DeliveryState> {
    if (!this.enabled) return 'UNKNOWN';
    const r = await this.request<{ records: Array<{ status: string }> }>('GET', `/sms-tools/logs?message_id=${encodeURIComponent(providerMessageId)}&per_page=1`);
    const s = (r.data?.records?.[0]?.status ?? '').toLowerCase();
    if (!s) return 'UNKNOWN';
    // Failures first: "undelivered" contains "deliver".
    if (/fail|reject|undeliv|expired/.test(s)) return 'FAILED';
    if (/deliver/.test(s)) return 'DELIVERED';
    return 'SENT'; // submitted, sent, pending
  }

  async status(): Promise<MessagingStatus> {
    const channels = { EMAIL: this.channelEnabled('EMAIL'), SMS: this.channelEnabled('SMS'), WHATSAPP: this.channelEnabled('WHATSAPP') };
    if (!this.enabled) return { configured: false, channels };
    try {
      const profile = await this.request<{ record: { first_name?: string; last_name?: string; email?: string; company?: string } }>('GET', '/profile');
      const wallet = await this.request<{ record?: { balance: string | number; currency_id?: string | number | null } }>('GET', '/wallet').catch(() => null);
      const p = profile.data?.record ?? {};
      const w = wallet?.data?.record;
      return {
        configured: true, channels,
        account: { name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.company || null, email: p.email ?? null },
        wallet: w && w.balance != null ? { balance: String(w.balance), currency: w.currency_id != null ? String(w.currency_id) : null } : null,
      };
    } catch (e) {
      return { configured: true, channels, error: (e as Error).message };
    }
  }

  /** PUT /whatsapp-servers/{uid}/forwarding (Veltrix migration 175): rotate_secret so we always learn the secret. */
  async configureWhatsappForwarding(url: string): Promise<{ secret: string }> {
    this.require('WHATSAPP');
    const uid = encodeURIComponent(this.config.get('VELTRIX_WHATSAPP_SERVER_UID', { infer: true })!);
    const r = await this.request<{ record: { secret?: string } }>('PUT', `/whatsapp-servers/${uid}/forwarding`, { url, enabled: true, forward_statuses: true, rotate_secret: true });
    const secret = r.data?.record?.secret;
    if (!secret) throw new MessagingUnavailableError('Veltrix did not return a forwarding secret');
    return { secret };
  }

  /** GET /whatsapp/senders → the platform number's APPROVED templates. */
  async whatsappTemplates(): Promise<WhatsappTemplateInfo[]> {
    this.require('WHATSAPP');
    const r = await this.request<{ records: Array<{ server_uid: string; templates: Array<{ name: string; language: string; category: string; params: number; header: string; named?: boolean }> }> }>('GET', '/whatsapp/senders');
    const uid = this.config.get('VELTRIX_WHATSAPP_SERVER_UID', { infer: true });
    const server = r.data?.records?.find((x) => x.server_uid === uid);
    return (server?.templates ?? []).map((t) => ({ name: t.name, language: t.language, category: t.category ?? '', params: Number(t.params) || 0, header: t.header || null, named: t.named === true }));
  }

  private require(channel: MessageChannel) {
    if (!this.channelEnabled(channel)) throw new MessagingNotConfiguredError(`Veltrix ${channel.toLowerCase()} is not configured`);
  }

  private async post<T>(path: string, body: unknown, idempotencyKey: string) {
    return this.request<T>('POST', path, body, idempotencyKey);
  }

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<{ data: T | undefined; replayed: boolean }> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'X-MW-PUBLIC-KEY': this.config.get('VELTRIX_API_KEY', { infer: true })!, Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      this.logger.warn(`Veltrix ${method} ${path.split('?')[0]} unreachable: ${(e as Error).name}`);
      throw new MessagingUnavailableError('Veltrix could not be reached');
    }
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    const replayed = res.headers.get('idempotent-replayed') === 'true';
    if (res.ok && json?.status === 'success') return { data: json.data, replayed };
    const msg = (typeof json?.error === 'string' ? json.error : `Veltrix request failed (${res.status})`).slice(0, 300);
    if (res.status >= 500 || res.status === 429 || res.status === 409 || res.status === 0) {
      this.logger.warn(`Veltrix ${method} ${path.split('?')[0]} → ${res.status}`);
      // A transactional email that Veltrix tried and failed comes back as 500 with the email record marked
      // "error": a definite failure (a retry must use a new key, or it would only replay this answer).
      const rec = (json?.data as { record?: { status?: string } } | undefined)?.record;
      throw new MessagingUnavailableError(msg, res.status === 500 && rec?.status === 'error');
    }
    if (res.status === 401) throw new MessagingRejectedError('Veltrix rejected the API key', 'UNAUTHORIZED');
    if (res.status === 402) throw new MessagingRejectedError(msg, 'INSUFFICIENT_BALANCE');
    if (res.status === 403) throw new MessagingRejectedError(msg, 'CHANNEL_DISABLED');
    if (res.status === 404) throw new MessagingRejectedError(msg, 'NOT_FOUND');
    throw new MessagingRejectedError(msg, 'REJECTED');
  }
}

/**
 * Veltrix Verify partner API (`/api/verify/v1`, Bearer `<key_id>.<secret>`): POST /kyc/business { type: cac|tin,
 * identifier, name } → data.check { id, type, status: success|not_found|error|failed|pending, matched, match_score,
 * name, environment } (VerifyPartnerController::business / publicCheck). Accepts `Idempotency-Key` (migration 169).
 */
@Injectable()
export class VeltrixVerifyAdapter extends VerificationProvider {
  private readonly logger = new Logger(VeltrixVerifyAdapter.name);

  constructor(private readonly config: ConfigService<Env, true>) {
    super();
  }

  get enabled() {
    return this.config.get('VELTRIX_ENABLED', { infer: true }) && !!this.config.get('VELTRIX_BASE_URL', { infer: true }) && !!this.config.get('VELTRIX_VERIFY_KEY', { infer: true });
  }

  async checkBusiness(input: { type: 'cac' | 'tin'; identifier: string; name: string; idempotencyKey: string }): Promise<BusinessCheckResult> {
    if (!this.enabled) throw new MessagingNotConfiguredError('Veltrix Verify is not configured');
    const url = `${this.config.get('VELTRIX_BASE_URL', { infer: true })!.replace(/\/+$/, '')}/api/verify/v1/kyc/business`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.get('VELTRIX_VERIFY_KEY', { infer: true })}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify({ type: input.type, identifier: input.identifier, name: input.name }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      this.logger.warn(`Veltrix Verify unreachable: ${(e as Error).name}`);
      throw new MessagingUnavailableError('Veltrix Verify could not be reached');
    }
    const json = (await res.json().catch(() => null)) as Envelope<{ check: { id: string; status: string; matched: boolean; match_score: number | null; name: string | null; environment: string | null }; message: string | null }> | null;
    if (res.status >= 500 || res.status === 429 || res.status === 409) throw new MessagingUnavailableError(json?.error ?? `Veltrix Verify unavailable (${res.status})`);
    if (!res.ok || json?.status !== 'success' || !json.data?.check) throw new MessagingRejectedError(json?.error ?? `Veltrix Verify refused the check (${res.status})`, res.status === 402 ? 'INSUFFICIENT_BALANCE' : 'REJECTED');
    const c = json.data.check;
    const status: BusinessCheckResult['status'] = c.status === 'success' ? (c.matched ? 'VERIFIED' : 'MISMATCH') : c.status === 'not_found' ? 'NOT_FOUND' : c.status === 'pending' ? 'PENDING' : 'ERROR';
    return { status, matched: !!c.matched, matchScore: c.match_score ?? null, registeredName: c.name ?? null, checkId: c.id ?? null, environment: c.environment ?? null, message: json.data.message ?? null };
  }
}
