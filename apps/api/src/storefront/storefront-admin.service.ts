import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../common/audit/audit.service';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { Env } from '../config/env';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

/** Accent colours offered in the storefront editor (each passes 4.5:1 contrast with white text). */
export const ACCENT_COLOURS = ['#0e7a4d', '#1d4ed8', '#b42318', '#6d28d9', '#b45309', '#121815', '#be185d', '#0369a1'] as const;

export interface Readiness { key: string; label: string; done: boolean }

/** Seller-side storefront settings (MASTER-SPEC §10): cover, accent colour, order instructions, publishing. */
@Injectable()
export class StorefrontAdminService {
  private readonly appUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true }).replace(/\/+$/, '');
  }

  async get(t: TenantContext) {
    const s = await this.prisma.forTenant(t.tenantId).storefrontSettings.findFirstOrThrow();
    return {
      isPublished: s.isPublished,
      publicUrl: `${this.appUrl}/store/${t.slug}`,
      orderInstructions: s.orderInstructions,
      theme: s.theme as { accentColor?: string },
      accentColours: ACCENT_COLOURS,
      coverUrl: s.coverKey ? await this.storage.readUrl(s.coverKey, 'cover') : null,
      readiness: await this.readiness(t.tenantId),
    };
  }

  async update(t: TenantContext, actor: AuthUser, dto: { orderInstructions?: string | null; accentColor?: string }) {
    const db = this.prisma.forTenant(t.tenantId);
    const current = await db.storefrontSettings.findFirstOrThrow({ select: { theme: true } });
    const theme = { ...(current.theme as object), ...(dto.accentColor ? { accentColor: dto.accentColor } : {}) };
    await db.storefrontSettings.updateMany({
      data: { orderInstructions: dto.orderInstructions === undefined ? undefined : dto.orderInstructions || null, theme: theme as Prisma.InputJsonObject },
    });
    await this.audit.record({ action: 'storefront.updated', actorId: actor.id, tenantId: t.tenantId, entityType: 'storefront', metadata: { fields: Object.keys(dto) } });
    return this.get(t);
  }

  presignCover(tenantId: string, contentType: string, contentLength: number) {
    return this.storage.presignUpload(tenantId, 'cover', contentType, contentLength);
  }

  async setCover(t: TenantContext, actor: AuthUser, key: string | null) {
    const db = this.prisma.forTenant(t.tenantId);
    const before = await db.storefrontSettings.findFirstOrThrow({ select: { coverKey: true } });
    const next = key ? (await this.storage.confirmUpload(t.tenantId, 'cover', key)).key : null;
    await db.storefrontSettings.updateMany({ data: { coverKey: next } });
    if (before.coverKey && before.coverKey !== next) await this.storage.delete(before.coverKey);
    await this.audit.record({ action: next ? 'storefront.cover_updated' : 'storefront.cover_removed', actorId: actor.id, tenantId: t.tenantId, entityType: 'storefront' });
    return this.get(t);
  }

  async setPublished(t: TenantContext, actor: AuthUser, publish: boolean) {
    if (publish) {
      const missing = (await this.readiness(t.tenantId)).filter((r) => !r.done);
      if (missing.length) {
        throw new ConflictException({ code: 'STOREFRONT_NOT_READY', missing, message: `Before publishing: ${missing.map((m) => m.label.toLowerCase()).join(', ')}` });
      }
    }
    await this.prisma.forTenant(t.tenantId).storefrontSettings.updateMany({ data: { isPublished: publish } });
    await this.audit.record({ action: publish ? 'storefront.published' : 'storefront.unpublished', actorId: actor.id, tenantId: t.tenantId, entityType: 'storefront' });
    return this.get(t);
  }

  /** What a storefront needs before customers can see it. */
  async readiness(tenantId: string): Promise<Readiness[]> {
    const db = this.prisma.forTenant(tenantId);
    const [s, products] = await Promise.all([
      db.storefrontSettings.findFirstOrThrow({ select: { description: true, whatsappNumber: true, contactPhone: true } }),
      db.product.count({ where: { status: 'ACTIVE', deletedAt: null, variants: { some: { isActive: true } } } }),
    ]);
    return [
      { key: 'description', label: 'Add a store description', done: !!s.description?.trim() },
      { key: 'contact', label: 'Add a WhatsApp or contact number', done: !!(s.whatsappNumber || s.contactPhone) },
      { key: 'product', label: 'Publish at least one active product', done: products > 0 },
    ];
  }
}
