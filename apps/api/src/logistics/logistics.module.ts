import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { LogisticsRegistry } from './logistics-provider';

/** Phase 10 (MASTER-SPEC §18): delivery zones and fees, pickup, per-order delivery records, logistics adapters. */
@Module({
  imports: [OrdersModule],
  controllers: [DeliveryController],
  providers: [DeliveryService, LogisticsRegistry],
  exports: [DeliveryService],
})
export class LogisticsModule {}
