import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { CurrentTenant, RequirePermissions, TenantScoped } from '../common/auth/decorators';
import type { TenantContext } from '../common/auth/request-context';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('workspace')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Tenant-Id', required: true, description: 'Active seller workspace (validated against membership)' })
@Controller({ path: 'workspace', version: '1' })
export class TenantsController {
  constructor(private readonly prisma: PrismaService) {}

  @TenantScoped() @Get()
  async current(@CurrentTenant() t: TenantContext) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: t.tenantId },
      select: {
        id: true, slug: true, businessName: true, businessType: true, businessCategory: true, status: true,
        country: true, state: true, city: true, defaultCurrency: true, verifiedAt: true, createdAt: true,
        subscriptions: {
          where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
          select: { status: true, currentPeriodEnd: true, trialEndsAt: true, plan: { select: { code: true, name: true } } },
          take: 1, orderBy: { createdAt: 'desc' },
        },
      },
    });
    return { ...tenant, role: t.roleKey, permissions: [...t.permissions].sort() };
  }

  @RequirePermissions('staff:manage') @Get('members')
  members(@CurrentTenant() t: TenantContext) {
    // Tenant-scoped client: tenantId is injected into the query regardless of what the caller passes.
    return this.prisma.forTenant(t.tenantId).tenantMember.findMany({
      select: {
        id: true, status: true, createdAt: true,
        role: { select: { key: true, name: true } },
        user: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  @RequirePermissions('audit:read') @Get('audit-logs')
  auditLogs(@CurrentTenant() t: TenantContext) {
    return this.prisma.forTenant(t.tenantId).auditLog.findMany({
      orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, action: true, actorId: true, entityType: true, entityId: true, metadata: true, ip: true, createdAt: true },
    });
  }
}
