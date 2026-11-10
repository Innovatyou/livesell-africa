import { PERMISSIONS, SYSTEM_ROLES } from './permissions';

describe('system roles', () => {
  it('only reference catalogued permissions', () => {
    for (const r of Object.values(SYSTEM_ROLES)) for (const p of r.permissions) expect(PERMISSIONS).toHaveProperty(p);
  });
  it('new roles stay narrow: no staff, settings, refunds, gateways or exports', () => {
    for (const k of ['DISPATCHER', 'ACCOUNTANT', 'CUSTOMER_CARE'] as const) {
      const p = SYSTEM_ROLES[k].permissions as readonly string[];
      for (const no of ['staff:manage', 'store:manage', 'payments:configure', 'payments:refund', 'customers:export', 'billing:manage']) expect(p).not.toContain(no);
    }
    expect(SYSTEM_ROLES.ACCOUNTANT.permissions).toContain('payments:verify_transfer');
    expect(SYSTEM_ROLES.DISPATCHER.permissions).not.toContain('payments:read');
  });
  it('owner has everything; sales assistant cannot touch money or staff', () => {
    expect(SYSTEM_ROLES.OWNER.permissions).toHaveLength(Object.keys(PERMISSIONS).length);
    const sa = SYSTEM_ROLES.SALES_ASSISTANT.permissions as readonly string[];
    for (const p of ['payments:configure', 'payments:refund', 'payments:verify_transfer', 'staff:manage', 'customers:export']) expect(sa).not.toContain(p);
  });
});
