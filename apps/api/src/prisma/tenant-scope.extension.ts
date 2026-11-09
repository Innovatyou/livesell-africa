import { Prisma } from '../generated/prisma/client';

/** Models carrying a `tenantId` column. Keep in sync with schema.prisma (a unit test enforces this). */
export const TENANT_SCOPED_MODELS = new Set<string>([
  'Role', 'TenantMember', 'StaffInvitation', 'Subscription', 'SubscriptionInvoice',
  'ProductCategory', 'Product', 'ProductVariant', 'Inventory', 'InventoryMovement',
  'Customer', 'CustomerAddress', 'SalesChannel', 'LiveSession', 'Order', 'OrderItem',
  'OrderStatusHistory', 'SellerPaymentAccount', 'PaymentTransaction', 'PaymentRefund',
  'Settlement', 'LedgerAccount', 'BankAccount', 'VirtualAccount', 'Notification',
  'NotificationUsage', 'StorefrontSettings', 'DeliveryZone', 'DeliveryOrder', 'Courier', 'ReportSchedule',
  'AffiliateAccount', 'AffiliateCommission', 'AuditLog',
  // Phase 2
  'SubscriptionEvent', 'BusinessVerification',
  // Phase 9
  'OutboxEvent', 'NotificationPreference', 'WhatsappConversation',
]);

const WHERE_OPS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'update', 'updateMany', 'updateManyAndReturn',
  'delete', 'deleteMany', 'upsert',
]);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);
const UPDATE_OPS = new Set(['update', 'updateMany', 'updateManyAndReturn', 'upsert']);

export class TenantScopeViolation extends Error {}

type Args = Record<string, any>;

/** Pure function so it can be unit-tested without a database. */
export function scopeArgs(model: string, operation: string, rawArgs: Args | undefined, tenantId: string): Args {
  if (!TENANT_SCOPED_MODELS.has(model)) return rawArgs ?? {};
  const args: Args = { ...(rawArgs ?? {}) };

  if (WHERE_OPS.has(operation)) {
    // tenantId is applied last so a caller-supplied tenantId can never widen the scope.
    args.where = { ...(args.where ?? {}), tenantId };
  }

  const stamp = (data: Args) => {
    if (data == null) return data;
    if ('tenant' in data) throw new TenantScopeViolation(`${model}: use the tenant-scoped client, not tenant relation writes`);
    if (data.tenantId !== undefined && data.tenantId !== tenantId) {
      throw new TenantScopeViolation(`${model}: cross-tenant write rejected`);
    }
    return { ...data, tenantId };
  };

  if (CREATE_OPS.has(operation)) {
    if (operation === 'upsert') args.create = stamp(args.create);
    else args.data = Array.isArray(args.data) ? args.data.map(stamp) : stamp(args.data);
  }

  if (UPDATE_OPS.has(operation)) {
    const data = operation === 'upsert' ? args.update : args.data;
    if (data && (('tenantId' in data && data.tenantId !== tenantId) || 'tenant' in data)) {
      throw new TenantScopeViolation(`${model}: tenant reassignment rejected`);
    }
  }
  return args;
}

export function tenantScopeExtension(tenantId: string) {
  return Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return query(scopeArgs(model, operation, args as Args, tenantId) as any);
        },
      },
    },
  });
}
