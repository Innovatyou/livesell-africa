import { Module } from '@nestjs/common';
import { LiveSessionsController, SalesChannelsController } from './live.controller';
import { LiveService } from './live.service';

@Module({ controllers: [LiveSessionsController, SalesChannelsController], providers: [LiveService] })
export class LiveModule {}
