import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { OrdersController } from './orders.controller';
import { OrdersJobs } from './orders.jobs';
import { OrdersService } from './orders.service';

@Module({
  imports: [BillingModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersJobs],
  exports: [OrdersService],
})
export class OrdersModule {}
