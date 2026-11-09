import type { PermissionKey } from '../../rbac/permissions';

export interface AuthUser {
  id: string;
  email: string;
  platformRole: 'NONE' | 'PLATFORM_ADMIN' | 'PLATFORM_SUPPORT';
}

export interface TenantContext {
  tenantId: string;
  slug: string;
  memberId: string;
  roleKey: string;
  permissions: ReadonlySet<PermissionKey>;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  pr: AuthUser['platformRole'];
  typ: 'access';
}
