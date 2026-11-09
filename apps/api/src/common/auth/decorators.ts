import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '../../rbac/permissions';
import type { AuthUser, TenantContext } from './request-context';

export const IS_PUBLIC = 'isPublic';
/** Skip JWT authentication (login, register, public storefront, webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRES_TENANT = 'requiresTenant';
/** Endpoint operates inside a seller workspace; TenantGuard resolves and validates membership. */
export const TenantScoped = () => SetMetadata(REQUIRES_TENANT, true);

export const PERMISSIONS_KEY = 'permissions';
/** Requires ALL listed permissions in the active tenant. Implies @TenantScoped(). */
export const RequirePermissions = (...perms: PermissionKey[]) => SetMetadata(PERMISSIONS_KEY, perms);

export const PLATFORM_ROLES_KEY = 'platformRoles';
export const RequirePlatformRole = (...roles: Array<'PLATFORM_ADMIN' | 'PLATFORM_SUPPORT'>) =>
  SetMetadata(PLATFORM_ROLES_KEY, roles);

export const ALLOW_INACTIVE_SUBSCRIPTION = 'allowInactiveSubscription';
/**
 * Lets a tenant-scoped write run even when the workspace has no live subscription (expired / cancelled).
 * Use only for billing recovery and security actions (e.g. disabling a staff member).
 */
export const AllowInactiveSubscription = () => SetMetadata(ALLOW_INACTIVE_SUBSCRIPTION, true);

export const CurrentUser =createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantContext => {
  const tenant = ctx.switchToHttp().getRequest().tenant;
  if (!tenant) throw new Error('CurrentTenant used on a route without @TenantScoped/@RequirePermissions');
  return tenant;
});
