import {
  ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthMailer } from '../auth/auth-mailer';
import { ARGON } from '../auth/auth.service';
import { ClientMeta, TokenService } from '../auth/token.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { AuditService } from '../common/audit/audit.service';
import type { AuthUser, TenantContext } from '../common/auth/request-context';
import { CryptoService } from '../common/crypto/crypto.service';
import { Prisma } from '../generated/prisma/client';
import { PRIVACY_VERSION, TERMS_VERSION } from '../legal/versions';
import { PrismaService } from '../prisma/prisma.service';
import { AcceptInvitationNewUserDto, CreateInvitationDto, UpdateMemberDto } from './staff.dto';

export const INVITE_TTL_MS = 7 * 86_400_000;
const INVALID = 'This invitation is invalid or has expired';

const INVITE_SELECT = { id: true, email: true, roleKey: true, status: true, expiresAt: true, createdAt: true, invitedBy: true } as const;

/**
 * Staff invitations and membership management (MASTER-SPEC §5). Seat limits come from the plan; pending
 * invitations count as seats so the limit can't be exceeded by inviting first and accepting later.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly mailer: AuthMailer,
    private readonly tokens: TokenService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ── Seller side (tenant-scoped) ──

  async invite(t: TenantContext, actor: AuthUser, dto: CreateInvitationDto, meta: ClientMeta) {
    const db = this.prisma.forTenant(t.tenantId);
    const role = await db.role.findFirst({ where: { key: dto.roleKey } });
    if (!role) throw new NotFoundException('Role not found');

    const existingUser = await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } });
    if (existingUser) {
      const member = await db.tenantMember.findFirst({ where: { userId: existingUser.id } });
      if (member?.status === 'ACTIVE') throw new ConflictException('This person is already a member of your team');
    }
    await this.expireStale(t.tenantId);

    const token = this.crypto.randomToken(32);
    const invitation = await db.$transaction(async (tx) => {
      // Serialise seat checks per tenant so two concurrent invites can't both take the last seat.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-seats:${t.tenantId}`}))`;
      const pending = await tx.staffInvitation.findFirst({ where: { email: dto.email, status: 'PENDING' } });
      if (pending) throw new ConflictException('An invitation is already pending for this email. Resend it instead.');
      await this.entitlements.assertCanAdd(t.tenantId, 'staff');
      return tx.staffInvitation.create({
        data: {
          email: dto.email, roleKey: role.key, tokenHash: this.crypto.hashToken(token), invitedBy: actor.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        } as Prisma.StaffInvitationUncheckedCreateInput,
        select: INVITE_SELECT,
      });
    });

    await this.sendInvite(t.tenantId, actor.id, dto.email, role.name, token, invitation.expiresAt);
    await this.audit.record({
      action: 'staff.invited', actorId: actor.id, tenantId: t.tenantId, entityType: 'staff_invitation', entityId: invitation.id,
      metadata: { email: dto.email, roleKey: role.key }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return invitation;
  }

  async listInvitations(tenantId: string) {
    await this.expireStale(tenantId);
    return this.prisma.forTenant(tenantId).staffInvitation.findMany({
      where: { status: { in: ['PENDING', 'EXPIRED'] } }, orderBy: { createdAt: 'desc' }, take: 100, select: INVITE_SELECT,
    });
  }

  /** New token + new expiry. Re-checks the seat limit when reviving an expired invitation. */
  async resend(t: TenantContext, actor: AuthUser, id: string) {
    const db = this.prisma.forTenant(t.tenantId);
    await this.expireStale(t.tenantId);
    const inv = await db.staffInvitation.findUnique({ where: { id } });
    if (!inv || !['PENDING', 'EXPIRED'].includes(inv.status)) throw new NotFoundException('Invitation not found');
    if (inv.status === 'EXPIRED') await this.entitlements.assertCanAdd(t.tenantId, 'staff');
    const token = this.crypto.randomToken(32);
    const updated = await db.staffInvitation.update({
      where: { id }, data: { tokenHash: this.crypto.hashToken(token), status: 'PENDING', expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
      select: INVITE_SELECT,
    });
    const role = await db.role.findFirst({ where: { key: inv.roleKey } });
    await this.sendInvite(t.tenantId, actor.id, inv.email, role?.name ?? inv.roleKey, token, updated.expiresAt);
    await this.audit.record({ action: 'staff.invitation_resent', actorId: actor.id, tenantId: t.tenantId, entityType: 'staff_invitation', entityId: id });
    return updated;
  }

  async revoke(t: TenantContext, actor: AuthUser, id: string) {
    const res = await this.prisma.forTenant(t.tenantId).staffInvitation.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'REVOKED' } });
    if (!res.count) throw new NotFoundException('Invitation not found');
    await this.audit.record({ action: 'staff.invitation_revoked', actorId: actor.id, tenantId: t.tenantId, entityType: 'staff_invitation', entityId: id });
  }

  async updateMember(t: TenantContext, actor: AuthUser, memberId: string, dto: UpdateMemberDto) {
    const db = this.prisma.forTenant(t.tenantId);
    const member = await db.tenantMember.findUnique({ where: { id: memberId }, include: { role: true } });
    if (!member) throw new NotFoundException('Member not found');
    if (member.role.key === 'OWNER') throw new ForbiddenException("The business owner's access can't be changed");
    if (member.userId === actor.id) throw new ForbiddenException("You can't change your own access");

    let roleId: string | undefined;
    if (dto.roleKey) {
      const role = await db.role.findFirst({ where: { key: dto.roleKey } });
      if (!role) throw new NotFoundException('Role not found');
      roleId = role.id;
    }
    if (dto.status === 'ACTIVE' && member.status !== 'ACTIVE') await this.entitlements.assertCanAdd(t.tenantId, 'staff');

    const updated = await db.tenantMember.update({
      where: { id: memberId }, data: { roleId, status: dto.status },
      select: { id: true, status: true, role: { select: { key: true, name: true } }, user: { select: { id: true, fullName: true, email: true } } },
    });
    await this.audit.record({
      action: 'staff.member_updated', actorId: actor.id, tenantId: t.tenantId, entityType: 'tenant_member', entityId: memberId,
      metadata: { roleKey: dto.roleKey, status: dto.status },
    });
    return updated;
  }

  // ── Invitee side (no tenant context: the invitation row is the authority) ──

  async lookup(token: string) {
    const inv = await this.findValid(token);
    const [tenant, role, user] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: inv.tenantId }, select: { businessName: true, slug: true } }),
      this.prisma.role.findFirst({ where: { tenantId: inv.tenantId, key: inv.roleKey }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } }),
    ]);
    return { businessName: tenant.businessName, storeSlug: tenant.slug, roleName: role?.name ?? inv.roleKey, email: inv.email, expiresAt: inv.expiresAt, accountExists: !!user };
  }

  /** Signed-in user accepts. The account email must match the invited email. */
  async acceptAsUser(user: AuthUser, token: string, meta: ClientMeta) {
    const inv = await this.findValid(token);
    if (user.email.toLowerCase() !== inv.email.toLowerCase()) {
      throw new ForbiddenException(`This invitation was sent to ${inv.email}. Sign in with that email to accept it.`);
    }
    const tenant = await this.prisma.$transaction(async (tx) => {
      await this.claim(tx, inv.id, user.id);
      await this.joinTenant(tx, inv.tenantId, user.id, inv.roleKey);
      return tx.tenant.findUniqueOrThrow({ where: { id: inv.tenantId }, select: { id: true, slug: true, businessName: true } });
    });
    await this.audit.record({ action: 'staff.invitation_accepted', actorId: user.id, tenantId: inv.tenantId, entityType: 'staff_invitation', entityId: inv.id, ip: meta.ip, userAgent: meta.userAgent });
    return { tenant };
  }

  /** New person accepts: creates the account (email proven by the emailed token) and signs them in. */
  async acceptAsNewUser(dto: AcceptInvitationNewUserDto, meta: ClientMeta) {
    const inv = await this.findValid(dto.token);
    if (await this.prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } })) {
      throw new ConflictException('An account already exists for this email. Sign in to accept the invitation.');
    }
    const passwordHash = await argon2.hash(dto.password, ARGON);
    let result: { user: { id: string; email: string; fullName: string }; tenant: { id: string; slug: string; businessName: string } };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: inv.email, phone: dto.phone, fullName: dto.fullName, passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() },
          select: { id: true, email: true, fullName: true },
        });
        await this.claim(tx, inv.id, user.id);
        await this.joinTenant(tx, inv.tenantId, user.id, inv.roleKey);
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: inv.tenantId }, select: { id: true, slug: true, businessName: true } });
        return { user, tenant };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('An account with this email or phone number already exists. Sign in to accept the invitation.');
      }
      throw e;
    }
    await this.audit.record({ action: 'staff.invitation_accepted', actorId: result.user.id, tenantId: inv.tenantId, entityType: 'staff_invitation', entityId: inv.id, metadata: { newAccount: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION }, ip: meta.ip, userAgent: meta.userAgent });
    const tokens = await this.tokens.issue({ id: result.user.id, email: result.user.email, platformRole: 'NONE' }, meta);
    return { ...result, tokens };
  }

  // ── helpers ──

  private async findValid(token: string) {
    const inv = await this.prisma.staffInvitation.findUnique({
      where: { tokenHash: this.crypto.hashToken(token) },
      include: { tenant: { select: { status: true } } },
    });
    if (!inv || inv.status !== 'PENDING' || inv.expiresAt <= new Date()) throw new NotFoundException(INVALID);
    if (inv.tenant.status === 'SUSPENDED' || inv.tenant.status === 'CLOSED') throw new NotFoundException(INVALID);
    return inv;
  }

  /** Single use: only one concurrent accept can move the invitation out of PENDING. */
  private async claim(tx: Prisma.TransactionClient, id: string, userId: string) {
    const c = await tx.staffInvitation.updateMany({
      where: { id, status: 'PENDING', expiresAt: { gt: new Date() } },
      data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedBy: userId },
    });
    if (c.count !== 1) throw new NotFoundException(INVALID);
  }

  private async joinTenant(tx: Prisma.TransactionClient, tenantId: string, userId: string, roleKey: string) {
    const role = await tx.role.findUnique({ where: { tenantId_key: { tenantId, key: roleKey } } });
    if (!role) throw new NotFoundException(INVALID);
    const existing = await tx.tenantMember.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
    if (existing?.status === 'ACTIVE') throw new ConflictException('You are already a member of this team');
    if (existing) {
      await tx.tenantMember.update({ where: { id: existing.id }, data: { roleId: role.id, status: 'ACTIVE' } });
    } else {
      await tx.tenantMember.create({ data: { tenantId, userId, roleId: role.id } });
    }
  }

  private async expireStale(tenantId: string) {
    await this.prisma.forTenant(tenantId).staffInvitation.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } }, data: { status: 'EXPIRED' },
    });
  }

  private async sendInvite(tenantId: string, actorId: string, email: string, roleName: string, token: string, expiresAt: Date) {
    const [tenant, inviter] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessName: true } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: actorId }, select: { fullName: true } }),
    ]);
    await this.mailer.sendStaffInvitation(email, { businessName: tenant.businessName, inviterName: inviter.fullName, roleName, token, expiresAt });
  }
}
