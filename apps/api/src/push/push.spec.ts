import { sellerPushFor } from './push.service';

describe('seller push rules', () => {
  it('customer orders and customer-reported transfers push; staff actions don’t', () => {
    expect(sellerPushFor('ORDER_PLACED', 'STOREFRONT', 'customer')).toEqual({ permission: 'orders:read', kind: 'new_order' });
    expect(sellerPushFor('ORDER_PLACED', 'WHATSAPP', 'customer')).toEqual({ permission: 'orders:read', kind: 'new_order' });
    expect(sellerPushFor('ORDER_PLACED', 'MANUAL', 'user')).toBeNull();
    expect(sellerPushFor('ORDER_PLACED', 'TIKTOK_LIVE', 'user')).toBeNull();
    expect(sellerPushFor('TRANSFER_REPORTED', 'STOREFRONT', 'customer')).toEqual({ permission: 'payments:verify_transfer', kind: 'transfer_reported' });
    expect(sellerPushFor('TRANSFER_REPORTED', 'MANUAL', 'user')).toBeNull();
    expect(sellerPushFor('PAYMENT_RECEIVED', 'STOREFRONT', 'system')).toBeNull();
  });
});
