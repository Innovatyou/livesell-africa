import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingJobs } from './billing.jobs';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { NotificationService } from '../notifications/notifications.service';
import { VeltrixBillingNotifier } from '../notifications/veltrix-mailers';
import { BillingNotifier, LogBillingNotifier } from './billing-notifier';
import { CommissionBillingService } from './commission-billing.service';
import { CommissionService } from './commission.service';
import { EntitlementsService } from './entitlements.service';
import { AdminPlansController, PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  controllers: [PlansController, AdminPlansController, BillingController],
  providers: [
    PlansService, SubscriptionsService, EntitlementsService, CommissionService, CommissionBillingService, BillingJobs,
    {
      provide: BillingNotifier,
      inject: [ConfigService, NotificationService],
      useFactory: (config: ConfigService<Env, true>, notifications: NotificationService) =>
        config.get('VELTRIX_ENABLED', { infer: true }) ? new VeltrixBillingNotifier(notifications) : new LogBillingNotifier(),
    },
  ],
  exports: [EntitlementsService, SubscriptionsService, CommissionService, CommissionBillingService],
})
export class BillingModule {}
