import { PERMISSIONS, SYSTEM_ROLES } from './permissions';

describe('system roles', () => {
  it('only reference catalogued permissions', () => {
    for (const r of Object.values(SYSTEM_ROLES)) for (const p of r.permissions) expect(PERMISSIONS).toHaveProperty(p);
  });
  it('owner has everything; sales assistant cannot touch money or staff', () => {
    expect(SYSTEM_ROLES.OWNER.permissions).toHaveLength(Object.keys(PERMISSIONS).length);
    const sa = SYSTEM_ROLES.SALES_ASSISTANT.permissions as readonly string[];
    for (const p of ['payments:configure', 'payments:refund', 'payments:verify_transfer', 'staff:manage', 'customers:export']) expect(sa).not.toContain(p);
  });
});
