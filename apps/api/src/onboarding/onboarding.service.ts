import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { BusinessVerificationStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { MessagingUnavailableError, VerificationProvider } from '../messaging/messaging-provider';
import { SubmitVerificationDto, UpdateStoreProfileDto } from './onboarding.dto';

export interface ChecklistItem {
  key: string;
  title: string;
  description: string;
  required: boolean;
  done: boolean;
  status?: string;
}

/**
 * Seller onboarding (MASTER-SPEC §6): store profile, logo, guided checklist, optional business verification.
 * The checklist is computed from real records every time — nothing is a stored "done" flag that can drift.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly verification: VerificationProvider,
  ) {}

  async checklist(t: TenantContext, user: AuthUser) {
    const db = this.prisma.forTenant(t.tenantId);
    const [u, store, members, invites, verification, products] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { emailVerifiedAt: true, phoneVerifiedAt: true } }),
      db.storefrontSettings.findFirst({ select: { logoKey: true, description: true, whatsappNumber: true, isPublished: true } }),
      db.tenantMember.count({ where: { status: 'ACTIVE' } }),
      db.staffInvitation.count({ where: { status: { in: ['PENDING', 'ACCEPTED'] } } }),
      db.businessVerification.findFirst({ orderBy: { createdAt: 'desc' }, select: { status: true } }),
      db.product.count({ where: { deletedAt: null } }),
    ]);
    const items: ChecklistItem[] = [
      { key: 'verify_email', title: 'Verify your email', description: 'Confirm the link we sent so you can recover your account.', required: true, done: !!u.emailVerifiedAt },
      { key: 'verify_phone', title: 'Verify your phone number', description: 'We text you a 6-digit code. Used for order alerts and account security.', required: true, done: !!u.phoneVerifiedAt },
      { key: 'store_profile', title: 'Complete your store profile', description: 'Add a short description and your WhatsApp number for customers.', required: true, done: !!(store?.description?.trim() && store?.whatsappNumber) },
      { key: 'logo', title: 'Upload your logo', description: 'PNG, JPG or WebP up to 2 MB. Shown on your storefront.', required: true, done: !!store?.logoKey },
      { key: 'add_product', title: 'Add your first product', description: 'Give it a product code like BAG001 that customers can send you during a live.', required: true, done: products > 0 },
      { key: 'publish_store', title: 'Publish your storefront', description: 'Make livesell.africa/store/' + t.slug + ' visible to customers.', required: true, done: !!store?.isPublished },
      { key: 'invite_team', title: 'Invite your team', description: 'Add store managers, sales assistants or live moderators.', required: false, done: members > 1 || invites > 0 },
      {
        key: 'business_verification', title: 'Verify your business', description: 'Registered with CAC? Submit your certificate to get a verified badge.',
        required: false, done: verification?.status === 'APPROVED', status: verification?.status,
      },
    ];
    const required = items.filter((i) => i.required);
    return {
      items,
      completed: items.filter((i) => i.done).length,
      total: items.length,
      requiredRemaining: required.filter((i) => !i.done).length,
      percent: Math.round((items.filter((i) => i.done).length / items.length) * 100),
    };
  }

  async profile(tenantId: string) {
    const [tenant, store] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          id: true, slug: true, businessName: true, businessType: true, businessCategory: true, email: true, phone: true,
          country: true, state: true, city: true, address: true, verifiedAt: true,
        },
      }),
      this.prisma.forTenant(tenantId).storefrontSettings.findFirstOrThrow({
        select: { logoKey: true, description: true, contactEmail: true, contactPhone: true, whatsappNumber: true, socialLinks: true, isPublished: true, allowPreorders: true },
      }),
    ]);
    const { logoKey, ...rest } = store;
    return { ...tenant, storefront: { ...rest, logoUrl: logoKey ? await this.storage.readUrl(logoKey, 'logo') : null } };
  }

  async updateProfile(t: TenantContext, actor: AuthUser, dto: UpdateStoreProfileDto) {
    const tenantData = {
      businessName: dto.businessName, businessCategory: dto.businessCategory, state: dto.state, city: dto.city, address: dto.businessAddress,
    };
    const storeData = {
      description: dto.description, contactEmail: dto.contactEmail, contactPhone: dto.contactPhone, whatsappNumber: dto.whatsappNumber,
      socialLinks: dto.socialLinks ? (stripUndefined({ ...dto.socialLinks }) as Prisma.InputJsonObject) : undefined,
      allowPreorders: dto.allowPreorders,
    };
    await this.prisma.forTenant(t.tenantId).$transaction(async (tx) => {
      // Tenant is the workspace row itself; its id comes from the validated tenant context, never from input.
      await tx.tenant.update({ where: { id: t.tenantId }, data: tenantData });
      await tx.storefrontSettings.updateMany({ data: storeData });
    });
    await this.audit.record({ action: 'store.profile_updated', actorId: actor.id, tenantId: t.tenantId, entityType: 'tenant', entityId: t.tenantId, metadata: { fields: Object.keys(dto) } });
    return this.profile(t.tenantId);
  }

  presignLogo(tenantId: string, contentType: string, contentLength: number) {
    return this.storage.presignUpload(tenantId, 'logo', contentType, contentLength);
  }

  async setLogo(t: TenantContext, actor: AuthUser, key: string) {
    const file = await this.storage.confirmUpload(t.tenantId, 'logo', key);
    const db = this.prisma.forTenant(t.tenantId);
    const before = await db.storefrontSettings.findFirstOrThrow({ select: { logoKey: true } });
    await db.storefrontSettings.updateMany({ data: { logoKey: file.key } });
    if (before.logoKey && before.logoKey !== file.key) await this.storage.delete(before.logoKey);
    await this.audit.record({ action: 'store.logo_updated', actorId: actor.id, tenantId: t.tenantId, entityType: 'storefront', metadata: { size: file.size, contentType: file.contentType } });
    return { logoUrl: await this.storage.readUrl(file.key, 'logo') };
  }

  async removeLogo(t: TenantContext, actor: AuthUser) {
    const db = this.prisma.forTenant(t.tenantId);
    const before = await db.storefrontSettings.findFirstOrThrow({ select: { logoKey: true } });
    if (!before.logoKey) return;
    await db.storefrontSettings.updateMany({ data: { logoKey: null } });
    await this.storage.delete(before.logoKey);
    await this.audit.record({ action: 'store.logo_removed', actorId: actor.id, tenantId: t.tenantId, entityType: 'storefront' });
  }

  // ── Business verification (seller side) ──

  async verificationStatus(tenantId: string) {
    const [tenant, latest] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { verifiedAt: true, businessType: true } }),
      this.prisma.forTenant(tenantId).businessVerification.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, registeredName: true, registrationType: true, registrationNumber: true, rejectionReason: true, createdAt: true, reviewedAt: true },
      }),
    ]);
    return { verifiedAt: tenant.verifiedAt, businessType: tenant.businessType, latest };
  }

  presignVerificationDocument(tenantId: string, contentType: string, contentLength: number) {
    return this.storage.presignUpload(tenantId, 'verification-document', contentType, contentLength);
  }

  async submitVerification(t: TenantContext, actor: AuthUser, dto: SubmitVerificationDto) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: t.tenantId }, select: { verifiedAt: true } });
    if (tenant.verifiedAt) throw new ConflictException('Your business is already verified');
    const db = this.prisma.forTenant(t.tenantId);
    if (await db.businessVerification.findFirst({ where: { status: 'PENDING' }, select: { id: true } })) {
      throw new ConflictException('A verification request is already under review');
    }
    const doc = await this.storage.confirmUpload(t.tenantId, 'verification-document', dto.documentKey);
    try {
      const row = await db.businessVerification.create({
        data: {
          registeredName: dto.registeredName, registrationType: dto.registrationType, registrationNumber: dto.registrationNumber,
          documentKey: doc.key, submittedBy: actor.id,
        } as Prisma.BusinessVerificationUncheckedCreateInput,
        select: { id: true, status: true, createdAt: true },
      });
      await this.audit.record({ action: 'business_verification.submitted', actorId: actor.id, tenantId: t.tenantId, entityType: 'business_verification', entityId: row.id, metadata: { registrationType: dto.registrationType } });
      // Registry lookup for the reviewer (Veltrix Verify). Advice only: approval stays a person's decision.
      await this.registryCheck(row.id, null);
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.storage.delete(doc.key);
        throw new ConflictException('A verification request is already under review');
      }
      throw e;
    }
  }

  // ── Business verification (platform review) ──

  adminList(status: BusinessVerificationStatus) {
    return this.prisma.businessVerification.findMany({
      where: { status }, orderBy: { createdAt: 'asc' }, take: 100,
      select: {
        id: true, status: true, registeredName: true, registrationType: true, registrationNumber: true, createdAt: true, reviewedAt: true,
        tenant: { select: { id: true, slug: true, businessName: true, businessType: true } },
      },
    });
  }

  async adminGet(id: string) {
    const row = await this.prisma.businessVerification.findUnique({
      where: { id }, include: { tenant: { select: { id: true, slug: true, businessName: true, businessType: true, email: true } } },
    });
    if (!row) throw new NotFoundException('Verification request not found');
    const { documentKey, ...rest } = row;
    return { ...rest, documentUrl: await this.storage.readUrl(documentKey, 'verification-document') };
  }

  /**
   * Automated CAC registry check through Veltrix Verify, stored on the request for the reviewer. Never approves or
   * rejects anything and never blocks the submission: outages and refusals are recorded as the check's outcome.
   */
  async registryCheck(id: string, actorId: string | null) {
    const row = await this.prisma.businessVerification.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Verification request not found');
    if (!this.verification.enabled || !['CAC_RC', 'CAC_BN'].includes(row.registrationType)) return { checked: false, automatedCheck: row.automatedCheck };
    let result: Record<string, unknown>;
    try {
      const r = await this.verification.checkBusiness({
        type: 'cac', identifier: row.registrationNumber.replace(/^(RC|BN)\s*/i, ''), name: row.registeredName,
        idempotencyKey: `ls-bv-${row.id}-${Date.now().toString(36)}`,
      });
      result = { ...r, provider: 'VELTRIX_VERIFY' };
    } catch (e) {
      result = { status: e instanceof MessagingUnavailableError ? 'UNAVAILABLE' : 'ERROR', message: (e as Error).message.slice(0, 300), provider: 'VELTRIX_VERIFY' };
    }
    const updated = await this.prisma.businessVerification.update({ where: { id }, data: { automatedCheck: result as Prisma.InputJsonValue, automatedCheckedAt: new Date() } });
    await this.audit.record({ action: 'business_verification.registry_checked', actorId, tenantId: row.tenantId, entityType: 'business_verification', entityId: id, metadata: { status: result.status } });
    return { checked: true, automatedCheck: updated.automatedCheck };
  }

  async adminDecide(id: string, reviewer: AuthUser, decision: 'APPROVED' | 'REJECTED', reason?: string) {
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const c = await tx.businessVerification.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: decision, reviewedBy: reviewer.id, reviewedAt: now, rejectionReason: decision === 'REJECTED' ? reason : null },
      });
      if (!c.count) throw new ConflictException('This request is not pending review');
      const r = await tx.businessVerification.findUniqueOrThrow({ where: { id }, select: { id: true, tenantId: true, status: true } });
      if (decision === 'APPROVED') await tx.tenant.update({ where: { id: r.tenantId }, data: { verifiedAt: now } });
      return r;
    });
    await this.audit.record({
      action: decision === 'APPROVED' ? 'business_verification.approved' : 'business_verification.rejected',
      actorId: reviewer.id, tenantId: row.tenantId, entityType: 'business_verification', entityId: id, metadata: reason ? { reason } : {},
    });
    return row;
  }
}

function stripUndefined(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
