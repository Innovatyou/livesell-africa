import {
  CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import type { PermissionKey } from '../../rbac/permissions';
import { ALLOW_INACTIVE_SUBSCRIPTION, IS_PUBLIC, PERMISSIONS_KEY, PLATFORM_ROLES_KEY, REQUIRES_TENANT } from './decorators';
import type { AccessTokenClaims, AuthUser, TenantContext } from './request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Req = Request & { user?: AuthUser; tenant?: TenantContext };

/** 1. Authenticates the bearer access token and confirms the user is still active. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<Req>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Missing bearer token');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(token, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (claims.typ !== 'access') throw new UnauthorizedException('Invalid token type');

    // Status re-checked per request so suspension takes effect before the access token expires.
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, status: true, platformRole: true },
    });
    if (!user || user.status === 'SUSPENDED') throw new UnauthorizedException('Account unavailable');
    req.user = { id: user.id, email: user.email, platformRole: user.platformRole };
    return true;
  }
}

/** 2. Platform-admin routes. */
@Injectable()
export class PlatformRoleGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<string[]>(PLATFORM_ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const user = ctx.switchToHttp().getRequest<Req>().user;
    if (!user || !roles.includes(user.platformRole)) throw new ForbiddenException('Platform role required');
    return true;
  }
}

/**
 * 3. Resolves the active tenant from `X-Tenant-Id` and verifies — server-side — that the authenticated
 * user is an ACTIVE member of a non-suspended tenant. The header is a selector, never an authority.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private reflector: Reflector, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const needsTenant =
      this.reflector.getAllAndOverride<boolean>(REQUIRES_TENANT, targets) ||
      !!this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets)?.length;
    if (!needsTenant) return true;

    const req = ctx.switchToHttp().getRequest<Req>();
    if (!req.user) throw new UnauthorizedException();
    const tenantId = req.header('x-tenant-id');
    if (!tenantId || !UUID.test(tenantId)) throw new ForbiddenException('X-Tenant-Id header required');

    const member = await this.prisma.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId: req.user.id } },
      include: {
        tenant: { select: { id: true, slug: true, status: true } },
        role: { include: { permissions: { include: { permission: { select: { key: true } } } } } },
      },
    });
    // Identical error for "not a member" and "no such tenant" — no tenant enumeration.
    if (!member || member.status !== 'ACTIVE') throw new ForbiddenException('No access to this workspace');
    if (member.tenant.status === 'SUSPENDED' || member.tenant.status === 'CLOSED') {
      throw new ForbiddenException('Workspace is suspended');
    }
    req.tenant = {
      tenantId: member.tenant.id,
      slug: member.tenant.slug,
      memberId: member.id,
      roleKey: member.role.key,
      permissions: new Set(member.role.permissions.map((rp) => rp.permission.key as PermissionKey)),
    };
    return true;
  }
}

/**
 * 5. Subscription entitlement. On tenant-scoped routes, writes (non-GET) require a live subscription
 * (TRIALING, ACTIVE, or PAST_DUE within the grace period). Reads keep working so sellers never lose sight
 * of their data; billing recovery routes opt out with @AllowInactiveSubscription().
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  private grace: { days: number; at: number } | null = null;
  constructor(private reflector: Reflector, private prisma: PrismaService) {}

  /** `billing.grace_days`, cached for a minute (read on every write). */
  private async graceDays() {
    if (this.grace && Date.now() - this.grace.at < 60_000) return this.grace.days;
    const s = await this.prisma.platformSetting.findUnique({ where: { key: 'billing.grace_days' } });
    const v = Number(s?.value);
    this.grace = { days: Number.isInteger(v) && v >= 0 && v <= 60 ? v : 3, at: Date.now() };
    return this.grace.days;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    if (!req.tenant || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_INACTIVE_SUBSCRIPTION, [ctx.getHandler(), ctx.getClass()])) return true;
    const live = await this.prisma.subscription.count({
      where: { tenantId: req.tenant.tenantId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
    });
    if (!live) {
      throw new HttpException(
        { statusCode: 402, code: 'SUBSCRIPTION_INACTIVE', message: 'Your LiveSell subscription has ended. Choose a plan to continue.' },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    // A commission invoice unpaid past its due date + grace days (Phase 10b) blocks writes the same way.
    const grace = await this.graceDays();
    const overdue = await this.prisma.subscriptionInvoice.count({
      where: { tenantId: req.tenant.tenantId, kind: 'COMMISSION', status: 'OPEN', dueAt: { lt: new Date(Date.now() - grace * 86_400_000) } },
    });
    if (overdue) {
      throw new HttpException(
        { statusCode: 402, code: 'COMMISSION_OVERDUE', message: 'Your LiveSell commission invoice is overdue. Pay it in Plan & billing to continue.' },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }
}

/** 4. Fine-grained permission check within the resolved tenant. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const tenant = ctx.switchToHttp().getRequest<Req>().tenant;
    const missing = required.filter((p) => !tenant?.permissions.has(p));
    if (missing.length) throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    return true;
  }
}
