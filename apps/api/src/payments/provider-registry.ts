import { Injectable } from '@nestjs/common';
import type { PaymentProviderCode } from '../generated/prisma/client';
import { BachsAdapter } from './bachs.adapter';
import { FlutterwaveAdapter } from './flutterwave.adapter';
import { PaymentProvider, PaymentProviderRegistry } from './payment-provider';
import { PaystackAdapter } from './paystack.adapter';

/**
 * Adapters that exist. Whether a provider may be used is decided separately by its `payment_providers` row
 * (`is_enabled`, set by a platform admin). Bank transfer arrives in Phase 7.
 */
@Injectable()
export class DefaultPaymentProviderRegistry extends PaymentProviderRegistry {
  private readonly adapters: Map<PaymentProviderCode, PaymentProvider>;

  constructor(paystack: PaystackAdapter, flutterwave: FlutterwaveAdapter, bachs: BachsAdapter) {
    super();
    this.adapters = new Map<PaymentProviderCode, PaymentProvider>([[paystack.code, paystack], [flutterwave.code, flutterwave], [bachs.code, bachs]]);
  }

  get(code: PaymentProviderCode): PaymentProvider | null {
    return this.adapters.get(code) ?? null;
  }
}
