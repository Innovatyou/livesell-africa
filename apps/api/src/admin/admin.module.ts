import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { AdminPortalController } from './admin.controller';
import { LedgerService } from '../ledger/ledger.service';
import { AdminService } from './admin.service';

/** Phase 11 (MASTER-SPEC §21): super-admin portal — overview, sellers, commission, webhooks, audit, settings. */
@Module({ imports: [BillingModule], controllers: [AdminPortalController], providers: [AdminService, LedgerService] })
export class AdminModule {}
