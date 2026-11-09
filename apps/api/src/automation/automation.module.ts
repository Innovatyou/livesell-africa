import { Module } from '@nestjs/common';
import { LogisticsModule } from '../logistics/logistics.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminWhatsappController, AutomationController, WhatsappPublicController } from './automation.controller';
import { AutomationJobs } from './automation.jobs';
import { OrderNotifier } from './order-notifier.service';
import { WhatsappAdminService } from './whatsapp-admin.service';
import { WhatsappCommerceService } from './whatsapp-commerce.service';

/** Phase 9: automatic order messages (outbox + reminders) and WhatsApp ordering on the platform number. */
@Module({
  imports: [OrdersModule, PaymentsModule, LogisticsModule],
  controllers: [AutomationController, WhatsappPublicController, AdminWhatsappController],
  providers: [OrderNotifier, WhatsappCommerceService, WhatsappAdminService, AutomationJobs],
  exports: [OrderNotifier, WhatsappCommerceService],
})
export class AutomationModule {}
