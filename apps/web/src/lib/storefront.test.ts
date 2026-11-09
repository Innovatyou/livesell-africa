import { describe, expect, it } from 'vitest';
import { cartTotal, whatsappLink, whatsappOrderText, type CartLine } from './storefront';

const line = (over: Partial<CartLine> = {}): CartLine => ({
  variantId: 'v1', productSlug: 'bag', productCode: 'BAG001', productName: 'Premium Leather Bag', variantName: 'Black',
  priceMinor: '2200000', quantity: 2, imageUrl: null, ...over,
});

describe('storefront cart', () => {
  it('totals in kobo with BigInt', () => {
    expect(cartTotal([line(), line({ variantId: 'v2', priceMinor: '150', quantity: 3 })])).toBe(4_400_450n);
    expect(cartTotal([])).toBe(0n);
  });

  it('builds a WhatsApp order message led by product codes', () => {
    const text = whatsappOrderText({ businessName: "Ada's", currency: 'NGN' }, [line(), line({ variantId: 'v2', productCode: 'SHOE002', productName: 'Sneakers', variantName: 'Default', priceMinor: '1850000', quantity: 1 })]);
    expect(text).toBe([
      "Hello Ada's, I'd like to order:",
      '• BAG001 Premium Leather Bag (Black) × 2 — ₦44,000',
      '• SHOE002 Sneakers × 1 — ₦18,500',
      'Total: ₦62,500', '', 'My name:', 'Delivery address:',
    ].join('\n'));
    expect(whatsappLink('+234 803 123 4567', 'Hi & bye')).toBe('https://wa.me/2348031234567?text=Hi%20%26%20bye');
  });
});

describe('WhatsApp ordering link (Phase 9)', () => {
  it('opens the platform number with the store name and product code', async () => {
    const { whatsappLink, whatsappOrderingText } = await import('./storefront');
    expect(whatsappLink('+2348000000009', whatsappOrderingText('ada-fashion', 'BAG001'))).toBe('https://wa.me/2348000000009?text=ada-fashion%20BAG001');
  });
});
