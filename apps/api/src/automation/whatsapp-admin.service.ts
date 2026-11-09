import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import type { Env } from '../config/env';
import { MessagingProvider, MessagingUnavailableError, WhatsappTemplateInfo } from '../messaging/messaging-provider';
import { ORDER_EVENTS, OrderEvent, WHATSAPP_PARAMS } from '../notifications/order-templates';
import { PrismaService } from '../prisma/prisma.service';

const FORWARDING_KEY = 'whatsapp.forwarding';
const TEMPLATES_KEY = 'whatsapp.templates';
const NUMBER_KEY = 'whatsapp.platform_number';
const AAD = 'platform:whatsapp-forward';
const TOLERANCE_S = 300;

interface Forwarding { url: string; secretEnc: string; connectedAt: string }

/** Pure: verify `X-Veltrix-Signature: t=<unix>,v1=<hex>` (HMAC-SHA256 of "t.body"); any v1 may match. */
export function verifyVeltrixSignature(secret: string, rawBody: Buffer, header: string | undefined, nowMs = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('=', 2) as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k, v]) => k === 'v1' && /^[0-9a-f]{64}$/i.test(v ?? '')).map(([, v]) => v);
  if (!Number.isInteger(t) || !sigs.length || Math.abs(nowMs / 1000 - t) > TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return sigs.some((s) => timingSafeEqual(expected, Buffer.from(s, 'hex')));
}

/**
 * Platform WhatsApp automation settings (admin): the platform number customers message, forwarding of its inbound
 * messages from Veltrix (secret stored encrypted), and which approved template each order event uses.
 */
@Injectable()
export class WhatsappAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    private readonly messaging: MessagingProvider,
  ) {}

  async settings() {
    const [fwd, templates, number] = await Promise.all([this.get<Forwarding>(FORWARDING_KEY), this.get<Record<string, { name: string; language: string } | null>>(TEMPLATES_KEY), this.get<string>(NUMBER_KEY)]);
    let approved: WhatsappTemplateInfo[] = [];
    let approvedError: string | null = null;
    if (this.messaging.channelEnabled('WHATSAPP')) {
      try {
        approved = await this.messaging.whatsappTemplates();
      } catch (e) {
        approvedError = (e as Error).message;
      }
    }
    return {
      channelEnabled: this.messaging.channelEnabled('WHATSAPP'),
      platformNumber: number ?? null,
      forwarding: { connected: !!fwd?.secretEnc, url: fwd?.url ?? this.inboundUrl(), connectedAt: fwd?.connectedAt ?? null },
      events: ORDER_EVENTS.map((e) => ({ event: e, params: WHATSAPP_PARAMS[e], template: templates?.[e] ?? null })),
      approvedTemplates: approved, approvedError,
    };
  }

  async update(actorId: string, dto: { platformNumber?: string | null; templates?: Record<string, { name: string; language: string } | null> }) {
    if (dto.platformNumber !== undefined && dto.platformNumber !== null && !/^\+[1-9]\d{7,14}$/.test(dto.platformNumber)) {
      throw new BadRequestException('platformNumber must be in international format, e.g. +2348031234567');
    }
    if (dto.templates) {
      const approved = this.messaging.channelEnabled('WHATSAPP') ? await this.messaging.whatsappTemplates().catch(() => [] as WhatsappTemplateInfo[]) : [];
      for (const [event, t] of Object.entries(dto.templates)) {
        if (!(ORDER_EVENTS as readonly string[]).includes(event)) throw new BadRequestException(`Unknown event ${event}`);
        if (t === null) continue;
        if (!t?.name || !t?.language || !/^[a-z0-9_]{1,512}$/.test(t.name) || !/^[a-z]{2}(_[A-Z]{2})?$/.test(t.language)) throw new BadRequestException(`${event}: give the template name and language (e.g. en or en_US)`);
        const found = approved.find((a) => a.name === t.name && a.language === t.language);
        if (approved.length && !found) throw new BadRequestException(`${event}: ${t.name} (${t.language}) is not an approved template on the platform number`);
        const expected = WHATSAPP_PARAMS[event as OrderEvent].length;
        if (found && found.params !== expected) throw new BadRequestException(`${event}: ${t.name} takes ${found.params} value(s); this message sends ${expected} (${WHATSAPP_PARAMS[event as OrderEvent].join(', ')})`);
        if (found?.named) throw new BadRequestException(`${event}: ${t.name} uses named values; LiveSell sends values in order ({{1}}, {{2}}…), so choose a template with numbered values`);
        if (found?.header) throw new BadRequestException(`${event}: ${t.name} needs a ${found.header} with every message; choose a template without a media header`);
      }
      const current = (await this.get<Record<string, unknown>>(TEMPLATES_KEY)) ?? {};
      await this.set(TEMPLATES_KEY, { ...current, ...dto.templates });
    }
    if (dto.platformNumber !== undefined) await this.set(NUMBER_KEY, dto.platformNumber);
    await this.audit.record({ action: 'platform.whatsapp_settings_updated', actorId, entityType: 'platform_setting', metadata: { platformNumber: dto.platformNumber, templates: dto.templates ? Object.keys(dto.templates) : [] } });
    return this.settings();
  }

  /** Point the platform number's inbound messages at LiveSell (Veltrix migration 175) and keep the secret encrypted. */
  async connectForwarding(actorId: string) {
    const url = this.inboundUrl();
    let secret: string;
    try {
      ({ secret } = await this.messaging.configureWhatsappForwarding(url));
    } catch (e) {
      if (e instanceof MessagingUnavailableError) throw new ServiceUnavailableException('Veltrix is not responding. Try again shortly.');
      throw new BadRequestException((e as Error).message);
    }
    await this.set(FORWARDING_KEY, { url, secretEnc: this.crypto.encrypt(secret, AAD), connectedAt: new Date().toISOString() });
    await this.audit.record({ action: 'platform.whatsapp_forwarding_connected', actorId, entityType: 'platform_setting', metadata: { url } });
    return this.settings();
  }

  /** Inbound forward check. False when forwarding isn't connected or the signature/timestamp don't verify. */
  async verify(rawBody: Buffer | undefined, header: string | undefined) {
    const fwd = await this.get<Forwarding>(FORWARDING_KEY);
    if (!rawBody?.length || !fwd?.secretEnc) return false;
    return verifyVeltrixSignature(this.crypto.decrypt(fwd.secretEnc, AAD), rawBody, header);
  }

  /** What a storefront needs for an "Order on WhatsApp" button. */
  async ordering(slug: string) {
    const t = await this.prisma.tenant.findUnique({ where: { slug }, select: { storefront: { select: { isPublished: true } }, status: true } });
    if (!t?.storefront?.isPublished || t.status === 'SUSPENDED' || t.status === 'CLOSED') throw new NotFoundException('Store not found');
    const [fwd, number] = await Promise.all([this.get<Forwarding>(FORWARDING_KEY), this.get<string>(NUMBER_KEY)]);
    const enabled = this.messaging.channelEnabled('WHATSAPP') && !!fwd?.secretEnc && !!number;
    return { enabled, number: enabled ? number : null, prefix: `${slug}` };
  }

  private inboundUrl() {
    return `${this.config.get('API_PUBLIC_URL', { infer: true })}/api/v1/whatsapp/webhook`;
  }

  private async get<T>(key: string): Promise<T | null> {
    const s = await this.prisma.platformSetting.findUnique({ where: { key } });
    return (s?.value as T) ?? null;
  }

  private set(key: string, value: unknown) {
    return this.prisma.platformSetting.upsert({ where: { key }, create: { key, value: value as object }, update: { value: value as object } });
  }
}
