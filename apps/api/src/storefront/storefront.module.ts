import { Module } from '@nestjs/common';
import { LogisticsModule } from '../logistics/logistics.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { StorefrontCheckoutService } from './storefront-checkout.service';
import { StorefrontAdminService } from './storefront-admin.service';
import { StorefrontAdminController, StorefrontPublicController } from './storefront.controller';
import { StorefrontPublicService } from './storefront-public.service';

@Module({
  imports: [OrdersModule, PaymentsModule, LogisticsModule],
  controllers: [StorefrontAdminController, StorefrontPublicController],
  providers: [StorefrontAdminService, StorefrontPublicService, StorefrontCheckoutService],
  exports: [StorefrontAdminService],
})
export class StorefrontModule {}
