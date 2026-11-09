import { Global, Module } from '@nestjs/common';
import { MessagingProvider, VerificationProvider } from '../messaging/messaging-provider';
import { VeltrixMessagingAdapter, VeltrixVerifyAdapter } from '../messaging/veltrix.adapter';
import { AdminMessagingController, MessagingController } from './notifications.controller';
import { NotificationsJobs } from './notifications.jobs';
import { NotificationService } from './notifications.service';

/**
 * Messaging (MASTER-SPEC §15). Global so auth, billing, onboarding and (Phase 9) orders can send. The Veltrix
 * adapters stay inert while VELTRIX_ENABLED=false: channels report "not configured" and nothing is sent.
 */
@Global()
@Module({
  controllers: [MessagingController, AdminMessagingController],
  providers: [
    { provide: MessagingProvider, useClass: VeltrixMessagingAdapter },
    { provide: VerificationProvider, useClass: VeltrixVerifyAdapter },
    NotificationService, NotificationsJobs,
  ],
  exports: [MessagingProvider, VerificationProvider, NotificationService],
})
export class NotificationsModule {}
