import { Global, Module } from '@nestjs/common';
import { PushController } from './push.controller';
import { ExpoPushAdapter, PushProvider } from './push-provider';
import { PushService } from './push.service';

/** Seller push notifications (mobile app) over the Expo push service. */
@Global()
@Module({ controllers: [PushController], providers: [PushService, { provide: PushProvider, useClass: ExpoPushAdapter }], exports: [PushService] })
export class PushModule {}
