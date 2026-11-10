import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { normalisePhone } from '../common/phone';
import * as argon2 from 'argon2';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PRIVACY_VERSION, TERMS_VERSION } from '../legal/versions';
import { RbacService } from '../rbac/rbac.service';
import { AuthMailer } from './auth-mailer';
import { LoginDto, RegisterDto } from './dto';
import { ClientMeta, TokenService } from './token.service';

// OWASP 2024 argon2id baseline.
export const ARGON = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const EMAIL_VERIFY_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 30 * 60_000;

/** Slugs that would collide with platform routes or invite impersonation. */
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'www', 'store', 'stores', 'login', 'register', 'signup', 'dashboard', 'support',
  'help', 'billing', 'pricing', 'livesell', 'livesellafrica', 'official', 'security', 'status', 'docs', 'static',
  // Path segments used under /api/v1/store/ by seller endpoints, and web routes.
  'profile', 'logo', 'cover', 'contact', 'terms', 'privacy', 'invite', 'onboarding', 'settings', 'products', 'customers', 'inventory',
]);

@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly mailer: AuthMailer,
  ) {}

  async register(dto: RegisterDto, meta: ClientMeta) {
    if (RESERVED_SLUGS.has(dto.storeUsername)) throw new ConflictException('That store username is not available');

    const passwordHash = await argon2.hash(dto.password, ARGON);
    const now = new Date();

    let result: { user: { id: string; email: string; fullName: string }; tenant: { id: string; slug: string; businessName: string } };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: dto.email, phone: dto.phone, passwordHash, fullName: dto.ownerFullName, status: 'PENDING_VERIFICATION' },
          select: { id: true, email: true, fullName: true },
        });
        const tenant = await tx.tenant.create({
          data: {
            slug: dto.storeUsername, businessName: dto.businessName, businessType: dto.businessType,
            businessCategory: dto.businessCategory, email: dto.email, phone: dto.phone, country: dto.country,
            state: dto.state, city: dto.city, address: dto.businessAddress, status: 'TRIAL',
            termsAcceptedAt: now, privacyAcceptedAt: now, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION,
          },
          select: { id: true, slug: true, businessName: true },
        });
        const roles = await this.rbac.createSystemRoles(tx, tenant.id);
        await tx.tenantMember.create({ data: { tenantId: tenant.id, userId: user.id, roleId: roles.OWNER } });
        await tx.storefrontSettings.create({ data: { tenantId: tenant.id, contactEmail: dto.email, contactPhone: dto.phone } });
        await tx.salesChannel.createMany({
          data: [
            { tenantId: tenant.id, type: 'STOREFRONT', name: 'Online store' },
            { tenantId: tenant.id, type: 'MANUAL', name: 'Manual / phone orders' },
          ],
        });
        // Start a trial on the entry plan if the platform has seeded one.
        // Every seller starts on the entry subscription plan; they can switch (incl. to commission) during the trial.
        const plan = await tx.subscriptionPlan.findFirst({ where: { isActive: true, isPublic: true, pricingModel: 'SUBSCRIPTION' }, orderBy: { sortOrder: 'asc' } });
        if (plan) {
          const trialEnd = new Date(now.getTime() + plan.trialDays * 86_400_000);
          const sub = await tx.subscription.create({
            data: { tenantId: tenant.id, planId: plan.id, status: 'TRIALING', currentPeriodStart: now, currentPeriodEnd: trialEnd, trialEndsAt: trialEnd },
          });
          await tx.subscriptionEvent.create({
            data: { tenantId: tenant.id, subscriptionId: sub.id, type: 'TRIAL_STARTED', toPlanId: plan.id, actorId: user.id, metadata: { trialDays: plan.trialDays } },
          });
        }
        return { user, tenant };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Deliberately generic: don't reveal which of email/phone/username exists.
        throw new ConflictException('An account with these details already exists, or the store username is taken');
      }
      throw err;
    }

    await this.sendVerification(result.user.id, result.user.email, result.user.fullName);
    await this.audit.record({
      action: 'auth.register', actorId: result.user.id, tenantId: result.tenant.id, ip: meta.ip, userAgent: meta.userAgent,
      metadata: { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
    });

    const tokens = await this.tokens.issue({ id: result.user.id, email: result.user.email, platformRole: 'NONE' }, meta);
    return { user: result.user, tenant: result.tenant, tokens };
  }

  async login(dto: LoginDto, meta: ClientMeta) {
    // Sign in with email or phone (unique per user); anything unrecognisable simply finds nobody.
    const id = (dto.identifier ?? dto.email ?? '').trim();
    const phone = id.includes('@') ? null : normalisePhone(id);
    const where = id.includes('@') ? { email: id.toLowerCase() } : phone ? { phone } : null;
    const user = where ? await this.prisma.user.findUnique({ where }) : null;
    // Always run argon2 so response time doesn't reveal whether the email exists.
    const ok = user
      ? await argon2.verify(user.passwordHash, dto.password)
      : (await argon2.verify(await this.getDummyHash(), dto.password), false);

    if (!user || !ok || user.status === 'SUSPENDED') {
      await this.audit.record({ action: 'auth.login_failed', actorId: user?.id, metadata: where ?? { identifier: id.slice(0, 64) }, ip: meta.ip, userAgent: meta.userAgent });
      throw new UnauthorizedException('Invalid email, phone or password');
    }
    if (argon2.needsRehash(user.passwordHash, ARGON)) {
      await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await argon2.hash(dto.password, ARGON) } });
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({ action: 'auth.login', actorId: user.id, ip: meta.ip, userAgent: meta.userAgent });
    return this.tokens.issue({ id: user.id, email: user.email, platformRole: user.platformRole }, meta);
  }

  async me(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true, email: true, phone: true, fullName: true, status: true, platformRole: true,
        emailVerifiedAt: true, phoneVerifiedAt: true, mfaEnabled: true,
        memberships: {
          where: { status: 'ACTIVE' },
          select: {
            id: true,
            role: { select: { key: true, name: true } },
            tenant: { select: { id: true, slug: true, businessName: true, status: true } },
          },
        },
      },
    });
  }

  async verifyEmail(token: string) {
    const row = await this.consumeToken(token, 'EMAIL_VERIFY');
    await this.prisma.user.update({
      where: { id: row.userId },
      data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
    });
    await this.audit.record({ action: 'auth.email_verified', actorId: row.userId });
  }

  async resendVerification(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return;
    await this.sendVerification(user.id, user.email, user.fullName);
  }

  /** Always succeeds from the caller's perspective — no account enumeration. */
  async requestPasswordReset(email: string, meta: ClientMeta) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status === 'SUSPENDED') return;
    const token = await this.createToken(user.id, 'PASSWORD_RESET', RESET_TTL_MS);
    await this.mailer.sendPasswordReset(user.email, user.fullName, token);
    await this.audit.record({ action: 'auth.password_reset_requested', actorId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  }

  async resetPassword(token: string, newPassword: string, meta: ClientMeta) {
    const row = await this.consumeToken(token, 'PASSWORD_RESET');
    await this.prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await argon2.hash(newPassword, ARGON) } });
    await this.tokens.revokeAllForUser(row.userId); // sign out every device
    await this.audit.record({ action: 'auth.password_reset', actorId: row.userId, ip: meta.ip, userAgent: meta.userAgent });
  }

  // ── helpers ──

  private async sendVerification(userId: string, email: string, name: string) {
    const token = await this.createToken(userId, 'EMAIL_VERIFY', EMAIL_VERIFY_TTL_MS);
    await this.mailer.sendEmailVerification(email, name, token);
  }

  private async createToken(userId: string, purpose: 'EMAIL_VERIFY' | 'PASSWORD_RESET', ttlMs: number) {
    // One live token per purpose: issuing a new one invalidates older ones.
    await this.prisma.verificationToken.updateMany({ where: { userId, purpose, consumedAt: null }, data: { consumedAt: new Date() } });
    const token = this.crypto.randomToken(32);
    await this.prisma.verificationToken.create({
      data: { userId, purpose, tokenHash: this.crypto.hashToken(token), expiresAt: new Date(Date.now() + ttlMs) },
    });
    return token;
  }

  private async consumeToken(token: string, purpose: 'EMAIL_VERIFY' | 'PASSWORD_RESET') {
    const tokenHash = this.crypto.hashToken(token);
    const claimed = await this.prisma.verificationToken.updateMany({
      where: { tokenHash, purpose, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) throw new BadRequestException('This link is invalid or has expired');
    return this.prisma.verificationToken.findUniqueOrThrow({ where: { tokenHash } });
  }

  private getDummyHash() {
    this.dummyHash ??= argon2.hash('dummy-password-for-timing', ARGON);
    return this.dummyHash;
  }
}
