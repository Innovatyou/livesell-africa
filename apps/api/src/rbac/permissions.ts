/**
 * Permission catalogue. Keys are `resource:action`. Seeded into `permissions`;
 * system roles are created per tenant at registration from SYSTEM_ROLES.
 */
export const PERMISSIONS = {
  'store:manage': 'Edit storefront, business profile and settings',
  'staff:manage': 'Invite, remove and change roles of staff',
  'billing:manage': 'Manage LiveSell subscription and invoices',
  'products:read': 'View products',
  'products:write': 'Create, edit and archive products',
  'inventory:read': 'View stock levels',
  'inventory:write': 'Adjust stock',
  'orders:read': 'View orders',
  'orders:create': 'Create orders (incl. during live sessions)',
  'orders:update_status': 'Move orders through fulfilment statuses',
  'orders:cancel': 'Cancel orders',
  'payments:read': 'View transactions',
  'payments:configure': 'Configure payment gateways and bank accounts',
  'payments:verify_transfer': 'Manually verify bank transfers',
  'payments:refund': 'Initiate refunds',
  'customers:read': 'View customers',
  'customers:write': 'Edit customers, notes and tags',
  'customers:export': 'Export customer data',
  'live:read': 'View live sessions',
  'live:manage': 'Create, run and end live sessions',
  'reports:read': 'View analytics and reports',
  'notifications:manage': 'Configure notifications',
  'delivery:manage': 'Manage delivery zones and dispatch',
  'affiliates:manage': 'Manage affiliates and commissions',
  'audit:read': 'View tenant audit log',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
const ALL = Object.keys(PERMISSIONS) as PermissionKey[];

export type SystemRoleKey = 'OWNER' | 'STORE_MANAGER' | 'SALES_ASSISTANT' | 'LIVE_MODERATOR' | 'DISPATCHER' | 'ACCOUNTANT' | 'CUSTOMER_CARE';

export const SYSTEM_ROLES: Record<SystemRoleKey, { name: string; permissions: PermissionKey[] }> = {
  OWNER: { name: 'Business owner', permissions: ALL },
  STORE_MANAGER: {
    name: 'Store manager',
    permissions: [
      'products:read', 'products:write', 'inventory:read', 'inventory:write',
      'orders:read', 'orders:create', 'orders:update_status', 'orders:cancel',
      'payments:read', 'payments:verify_transfer',
      'customers:read', 'customers:write',
      'live:read', 'live:manage', 'reports:read', 'delivery:manage',
    ],
  },
  SALES_ASSISTANT: {
    name: 'Sales assistant',
    permissions: ['products:read', 'inventory:read', 'orders:read', 'orders:create', 'orders:update_status', 'customers:read', 'live:read'],
  },
  LIVE_MODERATOR: {
    name: 'Live moderator',
    permissions: ['products:read', 'inventory:read', 'orders:read', 'orders:create', 'customers:read', 'live:read', 'live:manage'],
  },
  // Phase 14: roles Nigerian stores commonly split out. None of them can touch staff, settings, refunds or exports.
  DISPATCHER: {
    name: 'Dispatch & delivery',
    permissions: ['products:read', 'inventory:read', 'orders:read', 'orders:update_status', 'customers:read', 'delivery:manage'],
  },
  ACCOUNTANT: {
    name: 'Accounts',
    permissions: ['orders:read', 'payments:read', 'payments:verify_transfer', 'customers:read', 'reports:read'],
  },
  CUSTOMER_CARE: {
    name: 'Customer care',
    permissions: ['products:read', 'inventory:read', 'orders:read', 'orders:create', 'customers:read', 'customers:write', 'live:read'],
  },
};
