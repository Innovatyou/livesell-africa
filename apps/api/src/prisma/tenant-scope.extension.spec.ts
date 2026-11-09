import { Prisma } from '../generated/prisma/client';
import { scopeArgs, TENANT_SCOPED_MODELS, TenantScopeViolation } from './tenant-scope.extension';

const T = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('tenant scope extension', () => {
  it('covers exactly the models that have a tenantId column', () => {
    const withTenant = Object.values(Prisma.ModelName).filter((m) => {
      const fields = (Prisma as any)[`${m}ScalarFieldEnum`];
      return fields && 'tenantId' in fields;
    });
    expect(new Set(withTenant)).toEqual(TENANT_SCOPED_MODELS);
  });

  it('injects tenantId into reads and overrides a caller-supplied tenantId', () => {
    expect(scopeArgs('Product', 'findMany', { where: { status: 'ACTIVE' } }, T).where).toEqual({ status: 'ACTIVE', tenantId: T });
    expect(scopeArgs('Product', 'findMany', { where: { tenantId: OTHER } }, T).where.tenantId).toBe(T);
    expect(scopeArgs('Order', 'findUnique', { where: { id: 'x' } }, T).where).toEqual({ id: 'x', tenantId: T });
    expect(scopeArgs('Order', 'count', undefined, T).where).toEqual({ tenantId: T });
  });

  it('scopes updates and deletes', () => {
    for (const op of ['update', 'updateMany', 'delete', 'deleteMany']) {
      expect(scopeArgs('Customer', op, { where: { id: 'c' }, data: {} }, T).where.tenantId).toBe(T);
    }
  });

  it('stamps tenantId on create, createMany and upsert.create', () => {
    expect(scopeArgs('Product', 'create', { data: { name: 'Bag' } }, T).data.tenantId).toBe(T);
    const many = scopeArgs('Product', 'createMany', { data: [{ name: 'a' }, { name: 'b' }] }, T).data;
    expect(many.every((d: any) => d.tenantId === T)).toBe(true);
    expect(scopeArgs('Customer', 'upsert', { where: { id: 'c' }, create: { fullName: 'x' }, update: {} }, T).create.tenantId).toBe(T);
  });

  it('rejects cross-tenant writes and tenant reassignment', () => {
    expect(() => scopeArgs('Product', 'create', { data: { tenantId: OTHER } }, T)).toThrow(TenantScopeViolation);
    expect(() => scopeArgs('Product', 'create', { data: { tenant: { connect: { id: OTHER } } } }, T)).toThrow(TenantScopeViolation);
    expect(() => scopeArgs('Product', 'update', { where: { id: 'p' }, data: { tenantId: OTHER } }, T)).toThrow(TenantScopeViolation);
    expect(() => scopeArgs('Product', 'updateMany', { where: {}, data: { tenant: { connect: { id: OTHER } } } }, T)).toThrow(TenantScopeViolation);
  });

  it('leaves global models untouched', () => {
    expect(scopeArgs('SubscriptionPlan', 'findMany', { where: { isActive: true } }, T)).toEqual({ where: { isActive: true } });
  });
});
