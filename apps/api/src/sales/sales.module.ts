import { Module } from '@nestjs/common';
import { AdminSalesController, SalesController } from './sales.controller';
import { LogSalesNotifier, SalesNotifier, SalesService } from './sales.service';

@Module({
  controllers: [SalesController, AdminSalesController],
  providers: [SalesService, { provide: SalesNotifier, useClass: LogSalesNotifier }],
})
export class SalesModule {}
